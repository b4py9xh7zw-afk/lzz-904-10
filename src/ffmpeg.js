 'use strict';
const { spawn } = require('child_process');
const { fmtSec } = require('./util');

/** 补帧模式 → minterpolate 参数（“补帧提示”：速度/质量取舍） */
const INTERPOLATION_PRESETS = {
  fast:     'mi_mode=mci:mc_mode=obmc:me_mode=bilog',
  balanced: 'mi_mode=mci:mc_mode=aobmc:me_mode=bidir',
  quality:  'mi_mode=mci:mc_mode=aobmc:me_mode=esa:vsbmc=1',
};

/** 构造 atempo 链（单个 atempо 仅支持 0.5~100，慢放需串联） */
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push('atempo=' + s.toFixed(6).replace(/\.?0+$/, ''));
  return parts.join(',');
}

/**
 * 构造 ffmpeg 参数。
 * opts: { input, output, start, duration, speed, interpolation, targetFps, resolution, keepAudio }
 */
function buildArgs(o) {
  const args = ['-hide_banner', '-nostdin', '-nostats', '-y'];
  if (o.start > 0) args.push('-ss', fmtSec(o.start));
  if (o.duration > 0) args.push('-t', fmtSec(o.duration));
  args.push('-i', o.input);

  const vf = [];
  // 降速：拉长 PTS
  vf.push('setpts=' + (1 / o.speed).toFixed(6) + '*PTS');
  // 补帧：把被拉稀的帧率插值回目标帧率
  if (o.interpolation && o.interpolation !== 'none') {
    const preset = INTERPOLATION_PRESETS[o.interpolation] || INTERPOLATION_PRESETS.balanced;
    vf.push('minterpolate=fps=' + o.targetFps + ':' + preset);
  }
  // 清晰度
  if (o.resolution && o.resolution !== 'source') {
    vf.push('scale=-2:' + o.resolution);
  }
  args.push('-vf', vf.join(','));

  if (o.keepAudio) {
    args.push('-af', atempoChain(o.speed), '-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    o.output
  );
  return args;
}

/** 运行 ffmpeg（或 ffprobe），返回 { code, signal, timedOut, elapsedMs, stdout, stderr, spawnError } */
function runProcess(bin, args, timeoutSeconds) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      return resolve({ spawnError: e, code: null, signal: null, timedOut: false, elapsedMs: 0, stdout: '', stderr: '' });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutSeconds > 0
      ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeoutSeconds * 1000)
      : null;

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ spawnError: e, code: null, signal: null, timedOut, elapsedMs, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ code, signal, timedOut, elapsedMs, stdout, stderr });
    });
  });
}

/** ffprobe 探测：fps / 分辨率 / 时长 / 是否有音频 */
async function probe(ffprobePath, file) {
  const args = [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate',
    '-show_entries', 'format=duration',
    '-of', 'json', file,
  ];
  const r = await runProcess(ffprobePath, args, 15);
  if (r.spawnError) return { ok: false, error: '无法启动 ffprobe：' + r.spawnError.message };
  if (r.code !== 0) return { ok: false, error: 'ffprobe 返回非零退出码 ' + r.code };
  try {
    const j = JSON.parse(r.stdout);
    const streams = j.streams || [];
    const v = streams.find((s) => s.codec_type === 'video') || {};
    let fps = 0;
    if (v.r_frame_rate) {
      const [num, den] = String(v.r_frame_rate).split('/').map(Number);
      if (num && den) fps = num / den;
    }
    return {
      ok: true,
      fps,
      width: v.width || 0,
      height: v.height || 0,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      duration: parseFloat(j.format && j.format.duration) || 0,
    };
  } catch (e) {
    return { ok: false, error: 'ffprobe 输出解析失败：' + e.message };
  }
}

/** 从 stderr 提取错误摘要 */
function summarizeError(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).filter((l) => l.trim());
  const hit = lines.filter((l) =>
    /error|invalid|failed|failure|cannot|could not|no such|denied|unsupported|not found|conversion failed|moov atom|truncat/i.test(l)
  );
  const picked = (hit.length ? hit : lines).slice(-8);
  return picked.join('\n') || '（ffmpeg 未输出错误信息）';
}

module.exports = { buildArgs, runProcess, probe, summarizeError, atempoChain, INTERPOLATION_PRESETS };
