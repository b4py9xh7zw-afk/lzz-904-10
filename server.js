'use strict';
/**
 * 运动视频慢动作预览器 —— 零依赖 Node 后端
 * 功能：上传视频 → 选择降速比例/补帧提示/清晰度/裁剪时间段 → 调用 ffmpeg 生成短预览
 *       页面展示：执行的命令、耗时、错误摘要。ffmpeg 路径可在 config.json 或页面设置中修改（Win10 友好）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const { parseMultipart } = require('./src/multipart');
const ffmpeg = require('./src/ffmpeg');
const { genId, sanitizeFilename, buildCommandString, json, readBody, tailLines } = require('./src/util');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const PREVIEW_DIR = path.join(ROOT, 'previews');
for (const d of [UPLOAD_DIR, PREVIEW_DIR]) fs.mkdirSync(d, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ---------------- ffmpeg 可用性检测（带 15s 缓存） ---------------- */
let versionCache = { at: 0, key: '', result: null };
async function testBinary(binPath) {
  const r = await ffmpeg.runProcess(binPath, ['-version'], 8);
  if (r.spawnError) return { ok: false, error: r.spawnError.message };
  if (r.code !== 0) return { ok: false, error: '退出码 ' + r.code };
  const firstLine = (r.stdout || r.stderr).split(/\r?\n/)[0] || '';
  return { ok: true, version: firstLine.trim() };
}
async function configStatus() {
  const cfg = config.load();
  const key = cfg.ffmpegPath + '|' + cfg.ffprobePath;
  if (versionCache.key === key && Date.now() - versionCache.at < 15000) return versionCache.result;
  const [ff, fp] = await Promise.all([testBinary(cfg.ffmpegPath), testBinary(cfg.ffprobePath)]);
  const result = { ffmpeg: ff, ffprobe: fp };
  versionCache = { at: Date.now(), key, result };
  return result;
}

/* ---------------- 静态文件 / 预览文件 ---------------- */
function serveStatic(req, res, relPath) {
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

function servePreview(req, res, name) {
  if (!/^[\w.\-]+\.mp4$/.test(name)) return json(res, 400, { error: 'bad name' });
  const file = path.join(PREVIEW_DIR, name);
  if (!fs.existsSync(file)) return json(res, 404, { error: '预览不存在或已被清理' });
  const stat = fs.statSync(file);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (m[1] === '' && m[2]) { start = Math.max(0, stat.size - parseInt(m[2], 10)); end = stat.size - 1; }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="${name}"`,
    });
    fs.createReadStream(file).pipe(res);
  }
}

/* ---------------- 主流程：生成慢动作预览 ---------------- */
async function handlePreview(req, res) {
  const cfg = config.load();
  const ct = req.headers['content-type'] || '';
  if (!/multipart\/form-data/i.test(ct)) return json(res, 400, { error: '需要 multipart/form-data' });

  let body;
  try {
    body = await readBody(req, cfg.maxUploadMB * 1024 * 1024 + 2 * 1024 * 1024);
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }

  let fields, files;
  try {
    ({ fields, files } = parseMultipart(body, ct));
  } catch (e) {
    return json(res, 400, { error: '表单解析失败：' + e.message });
  }

  const video = files.find((f) => f.name === 'video');
  if (!video || !video.data.length) return json(res, 400, { error: '未收到视频文件（字段名 video）' });

  // ---- 参数解析与校验 ----
  const speed = parseFloat(fields.speed);
  if (!(speed >= 0.1 && speed <= 1)) {
    return json(res, 400, { error: '降速比例需在 0.1 ~ 1.0 之间（如 0.5 表示半速）' });
  }
  const interpolation = ['none', 'fast', 'balanced', 'quality'].includes(fields.interpolation)
    ? fields.interpolation : 'none';
  const resolution = ['source', '1080', '720', '480'].includes(fields.resolution)
    ? fields.resolution : 'source';
  const keepAudio = fields.keepAudio === '1' || fields.keepAudio === 'true';
  const start = Math.max(0, parseFloat(fields.start) || 0);
  const endRaw = parseFloat(fields.end);
  let targetFps = parseInt(fields.targetFps, 10);
  if (!Number.isFinite(targetFps) || targetFps <= 0) targetFps = 0; // 0 = 自动
  targetFps = Math.min(targetFps, 240);

  const warnings = [];

  // ---- 保存上传文件 ----
  const id = genId();
  const inputName = id + '_' + sanitizeFilename(video.filename);
  const inputPath = path.join(UPLOAD_DIR, inputName);
  fs.writeFileSync(inputPath, video.data);

  const cleanupInput = () => fs.unlink(inputPath, () => {});

  try {
    // ---- 探测源信息 ----
    const probeRes = await ffmpeg.probe(cfg.ffprobePath, inputPath);
    if (!probeRes.ok) warnings.push('ffprobe 探测失败（' + probeRes.error + '），已使用默认参数');

    const srcFps = probeRes.ok && probeRes.fps ? Math.round(probeRes.fps) : 30;
    const fps = targetFps > 0 ? targetFps : srcFps;

    // ---- 裁剪时间段 ----
    // 用户显式传了 end 但不大于 start → 明确报错，避免静默产出非预期片段
    if (fields.end !== undefined && fields.end !== '' && !(endRaw > start)) {
      cleanupInput();
      return json(res, 400, { error: '结束时间需大于开始时间' });
    }
    let duration;
    if (Number.isFinite(endRaw) && endRaw > start) {
      duration = endRaw - start;
    } else if (probeRes.ok && probeRes.duration > start) {
      duration = probeRes.duration - start;
    } else {
      duration = cfg.maxSegmentSeconds;
    }
    if (duration > cfg.maxSegmentSeconds) {
      duration = cfg.maxSegmentSeconds;
      warnings.push(`裁剪时间段超过上限，已截断为 ${cfg.maxSegmentSeconds} 秒`);
    }

    // ---- 构造并执行 ffmpeg ----
    const outputName = `preview_${id}.mp4`;
    const outputPath = path.join(PREVIEW_DIR, outputName);
    const argv = ffmpeg.buildArgs({
      input: inputPath, output: outputPath,
      start, duration, speed, interpolation,
      targetFps: fps, resolution, keepAudio,
    });
    const command = buildCommandString(cfg.ffmpegPath, argv);
    const run = await ffmpeg.runProcess(cfg.ffmpegPath, argv, cfg.jobTimeoutSeconds);
    cleanupInput();

    const stderrTail = tailLines(run.stderr, 40, 4000);
    const base = {
      command,
      elapsedMs: Math.round(run.elapsedMs),
      warnings,
      probe: probeRes.ok
        ? { duration: probeRes.duration, fps: srcFps, width: probeRes.width, height: probeRes.height, hasAudio: probeRes.hasAudio }
        : null,
      params: {
        speed, interpolation, targetFps: fps, resolution, keepAudio,
        start, duration: Math.round(duration * 1000) / 1000,
        expectedOutputSeconds: Math.round((duration / speed) * 100) / 100,
      },
    };

    if (run.spawnError) {
      return json(res, 200, Object.assign(base, {
        ok: false,
        errorSummary: `无法启动 ffmpeg：${run.spawnError.message}\n请检查「设置」中的 ffmpeg 路径（Win10 示例：C:\\ffmpeg\\bin\\ffmpeg.exe）`,
        stderrTail,
      }));
    }
    if (run.timedOut) {
      return json(res, 200, Object.assign(base, {
        ok: false,
        errorSummary: `处理超时（>${cfg.jobTimeoutSeconds}s），已终止。可尝试降低清晰度/缩短时间段/改用「快速」补帧。`,
        stderrTail,
      }));
    }
    if (run.code !== 0 || !fs.existsSync(outputPath)) {
      return json(res, 200, Object.assign(base, {
        ok: false,
        exitCode: run.code,
        errorSummary: ffmpeg.summarizeError(run.stderr),
        stderrTail,
      }));
    }

    const stat = fs.statSync(outputPath);
    return json(res, 200, Object.assign(base, {
      ok: true,
      previewUrl: '/previews/' + outputName,
      downloadName: 'slowmo_' + sanitizeFilename(video.filename).replace(/\.[^.]+$/, '') + '.mp4',
      outputBytes: stat.size,
      stderrTail,
    }));
  } catch (e) {
    cleanupInput();
    return json(res, 500, { error: '服务器内部错误：' + e.message });
  }
}

/* ---------------- 配置读写 ---------------- */
async function handleGetConfig(req, res) {
  const cfg = config.load();
  const status = await configStatus();
  json(res, 200, Object.assign({}, cfg, status));
}

async function handleSaveConfig(req, res) {
  let body;
  try {
    body = await readBody(req, 64 * 1024);
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
  let patch;
  try {
    patch = JSON.parse(body.toString('utf8') || '{}');
  } catch (_) {
    return json(res, 400, { error: 'JSON 解析失败' });
  }
  const cfg = config.save(patch);
  versionCache = { at: 0, key: '', result: null }; // 配置变了，清缓存重新检测
  const status = await configStatus();
  json(res, 200, Object.assign({ saved: true }, cfg, status));
}

/* ---------------- 预览清理 ---------------- */
function sweepPreviews(maxAgeMinutes) {
  if (!maxAgeMinutes) return 0;
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  let n = 0;
  for (const name of fs.readdirSync(PREVIEW_DIR)) {
    if (!/^preview_[\w-]+\.mp4$/.test(name)) continue;
    const p = path.join(PREVIEW_DIR, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); n++; }
    } catch (_) {}
  }
  return n;
}

function handleClearPreviews(req, res) {
  let n = 0;
  for (const name of fs.readdirSync(PREVIEW_DIR)) {
    if (!/^preview_[\w-]+\.mp4$/.test(name)) continue;
    try { fs.unlinkSync(path.join(PREVIEW_DIR, name)); n++; } catch (_) {}
  }
  json(res, 200, { ok: true, removed: n });
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(req, res, 'index.html');
    if (req.method === 'GET' && (p === '/app.js' || p === '/style.css' || p === '/favicon.svg')) {
      return serveStatic(req, res, p.slice(1));
    }
    if (req.method === 'GET' && p === '/api/config') return await handleGetConfig(req, res);
    if (req.method === 'POST' && p === '/api/config') return await handleSaveConfig(req, res);
    if (req.method === 'POST' && p === '/api/preview') return await handlePreview(req, res);
    if (req.method === 'DELETE' && p === '/api/previews') return handleClearPreviews(req, res);
    if (req.method === 'GET' && p.startsWith('/previews/')) return servePreview(req, res, p.slice('/previews/'.length));
    return json(res, 404, { error: 'not found: ' + req.method + ' ' + p });
  } catch (e) {
    return json(res, 500, { error: '服务器错误：' + e.message });
  }
});

const cfg = config.load();
server.listen(cfg.port, cfg.host, () => {
  console.log(`慢动作预览器已启动: http://localhost:${cfg.port}`);
  console.log(`ffmpeg 路径: ${cfg.ffmpegPath}（可在页面「设置」或 config.json 中修改）`);
  sweepPreviews(cfg.previewTtlMinutes);
  if (cfg.previewTtlMinutes > 0) {
    setInterval(() => sweepPreviews(cfg.previewTtlMinutes), 15 * 60 * 1000).unref();
  }
});
