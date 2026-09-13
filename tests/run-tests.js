'use strict';
/**
 * 端到端测试：启动真实服务器 + 真实 ffmpeg，覆盖
 * 配置读取/保存、预览生成（补帧/不补帧/无音频/去音频）、参数校验、错误摘要、Range 请求、清理。
 * 运行：node tests/run-tests.js
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8329;
const BASE = `http://127.0.0.1:${PORT}`;

// 定位 ffmpeg：优先环境变量，其次常见路径
const CANDIDATES = [
  process.env.TEST_FFMPEG,
  '/tmp/ffmpeg-7.0.2-amd64-static/ffmpeg',
  'ffmpeg',
].filter(Boolean);
let FFMPEG = null;
for (const c of CANDIDATES) {
  const r = spawnSync(c, ['-version'], { stdio: 'pipe' });
  if (!r.error && r.status === 0) { FFMPEG = c; break; }
}
if (!FFMPEG) {
  console.error('未找到 ffmpeg，无法运行端到端测试。可设 TEST_FFMPEG=/path/to/ffmpeg');
  process.exit(2);
}
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, (m) => (m.includes('exe') ? 'ffprobe.exe' : 'ffprobe'));
console.log('使用 ffmpeg:', FFMPEG);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'slowmo-test-'));
const VID_WITH_AUDIO = path.join(TMP, 'with_audio.mp4');
const VID_NO_AUDIO = path.join(TMP, 'no_audio.mp4');
const VID_CORRUPT = path.join(TMP, 'corrupt.mp4');

function sh(bin, args) {
  const r = spawnSync(bin, args, { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`命令失败: ${bin} ${args.join(' ')}\n${r.stderr}`);
}

// 生成测试素材
console.log('生成测试视频…');
sh(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', VID_WITH_AUDIO]);
sh(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=640x360:rate=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', VID_NO_AUDIO]);
fs.writeFileSync(VID_CORRUPT, Buffer.from('这不是一个视频文件，应该触发 ffmpeg 报错'.repeat(50)));

// 写入指向静态 ffmpeg 的配置
fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({
  ffmpegPath: FFMPEG, ffprobePath: FFPROBE, port: PORT, maxSegmentSeconds: 15,
}, null, 2));

// 启动服务器
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

function waitReady() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('服务器启动超时')), 15000);
    const poll = async () => {
      try {
        const r = await fetch(BASE + '/api/config');
        if (r.ok) { clearTimeout(t); resolve(); return; }
      } catch (_) {}
      setTimeout(poll, 200);
    };
    poll();
  });
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; console.log('  ❌', name, extra ? '→ ' + extra : ''); }
}

function ffprobeJson(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height,r_frame_rate', '-show_entries', 'format=duration',
    '-of', 'json', file], { stdio: 'pipe' });
  return JSON.parse(r.stdout.toString());
}

function upload(filePath, fields) {
  const fd = new FormData();
  fd.append('video', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fetch(BASE + '/api/preview', { method: 'POST', body: fd }).then((r) => r.json());
}

async function main() {
  await waitReady();
  console.log('服务器已就绪\n--- 开始测试 ---');

  // 1. 配置读取
  let r = await fetch(BASE + '/api/config');
  let cfg = await r.json();
  check('GET /api/config 返回 200', r.status === 200);
  check('ffmpeg 检测可用', cfg.ffmpeg && cfg.ffmpeg.ok === true, JSON.stringify(cfg.ffmpeg));
  check('ffprobe 检测可用', cfg.ffprobe && cfg.ffprobe.ok === true);

  // 2. 静态页面
  r = await fetch(BASE + '/');
  const html = await r.text();
  check('首页可访问且为中文页面', r.status === 200 && html.includes('慢动作预览器'));
  r = await fetch(BASE + '/app.js');
  check('app.js 可访问', r.status === 200);

  // 3. 正常预览：0.5x + 均衡补帧 + 720p + 裁剪 1s~4s（源 3s → 输出约 6s）
  console.log('  …生成预览（补帧，约需几秒）');
  let j = await upload(VID_WITH_AUDIO, {
    speed: 0.5, interpolation: 'balanced', resolution: '720', start: 1, end: 4, keepAudio: '1',
  });
  check('预览生成成功', j.ok === true, j.errorSummary);
  check('返回执行的命令', typeof j.command === 'string' && j.command.includes('setpts=2'));
  check('命令含 minterpolate 补帧', j.command.includes('minterpolate'));
  check('命令含裁剪参数 -ss 1 -t 3', j.command.includes('-ss 1') && j.command.includes('-t 3'));
  check('返回耗时', typeof j.elapsedMs === 'number' && j.elapsedMs > 0);
  check('返回探测信息', j.probe && j.probe.hasAudio === true && Math.abs(j.probe.duration - 6) < 0.5);
  if (j.ok) {
    const out = path.join(ROOT, j.previewUrl.replace('/previews/', 'previews/'));
    const meta = ffprobeJson(out);
    const dur = parseFloat(meta.format.duration);
    const v = meta.streams.find((s) => s.codec_type === 'video');
    check('输出时长≈6s（3s/0.5）', Math.abs(dur - 6) < 0.6, '实际 ' + dur);
    check('输出高度=720', v.height === 720, '实际 ' + v.height);
    check('输出含音频流', meta.streams.some((s) => s.codec_type === 'audio'));
    // Range 请求
    const rr = await fetch(BASE + j.previewUrl, { headers: { Range: 'bytes=0-1023' } });
    check('预览支持 Range 请求(206)', rr.status === 206);
    await rr.arrayBuffer();
  }

  // 4. 不补帧 + 0.25x + 去音频 + 480p
  j = await upload(VID_WITH_AUDIO, {
    speed: 0.25, interpolation: 'none', resolution: '480', start: 0, end: 2, keepAudio: '0',
  });
  check('不补帧预览成功', j.ok === true, j.errorSummary);
  check('命令不含 minterpolate', !j.command.includes('minterpolate'));
  check('去音频命令含 -an', j.command.includes(' -an'));

  // 4b. 单元级：atempo 链与命令构造
  const ffmod = require('../src/ffmpeg');
  check('atempoChain(0.25) 串联两级', ffmod.atempoChain(0.25) === 'atempo=0.5,atempo=0.5', ffmod.atempoChain(0.25));
  check('atempoChain(0.5) 单级', ffmod.atempoChain(0.5) === 'atempo=0.5');
  const argv = ffmod.buildArgs({ input: 'in.mp4', output: 'out.mp4', start: 1, duration: 2, speed: 0.5, interpolation: 'quality', targetFps: 60, resolution: '720', keepAudio: true });
  const cmdline = argv.join(' ');
  check('buildArgs 高质量补帧含 vsbmc', cmdline.includes('minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=esa:vsbmc=1'));
  check('buildArgs 含缩放与 setpts', cmdline.includes('scale=-2:720') && cmdline.includes('setpts=2.000000*PTS'));
  if (j.ok) {
    const out = path.join(ROOT, j.previewUrl.replace('/previews/', 'previews/'));
    const meta = ffprobeJson(out);
    const dur = parseFloat(meta.format.duration);
    check('输出时长≈8s（2s/0.25）', Math.abs(dur - 8) < 0.8, '实际 ' + dur);
    check('输出无音频流', !meta.streams.some((s) => s.codec_type === 'audio'));
    check('输出高度=480', meta.streams.find((s) => s.codec_type === 'video').height === 480);
  }

  // 5. 无音频源 + 保留音频 → 不应报错
  j = await upload(VID_NO_AUDIO, { speed: 0.5, interpolation: 'none', resolution: 'source', start: 0, end: 2, keepAudio: '1' });
  check('无音频源+保留音频 不报错', j.ok === true, j.errorSummary);

  // 6. 参数校验
  j = await upload(VID_WITH_AUDIO, { speed: 1.5, interpolation: 'none', resolution: '720', start: 0, end: 2, keepAudio: '1' });
  check('speed=1.5 被拒绝', j.error && j.error.includes('降速比例'));
  j = await upload(VID_WITH_AUDIO, { speed: 0.5, interpolation: 'none', resolution: '720', start: 3, end: 2, keepAudio: '1' });
  check('end<start 返回明确错误', j.error && j.error.includes('结束时间'), JSON.stringify(j));

  // 7. 损坏文件 → 错误摘要
  j = await upload(VID_CORRUPT, { speed: 0.5, interpolation: 'none', resolution: '720', start: 0, end: 2, keepAudio: '1' });
  check('损坏文件 ok=false', j.ok === false);
  check('返回错误摘要', typeof j.errorSummary === 'string' && j.errorSummary.length > 0);
  check('仍返回命令与耗时', typeof j.command === 'string' && j.elapsedMs >= 0);

  // 8. 错误 ffmpeg 路径 → 友好错误
  r = await fetch(BASE + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ffmpegPath: 'C:\\not-exist\\ffmpeg.exe' }),
  });
  cfg = await r.json();
  check('保存错误路径后 ffmpeg 检测失败', cfg.ffmpeg.ok === false);
  j = await upload(VID_WITH_AUDIO, { speed: 0.5, interpolation: 'none', resolution: '720', start: 0, end: 1, keepAudio: '1' });
  check('错误路径 → ok=false 且提示检查路径', j.ok === false && /无法启动 ffmpeg/.test(j.errorSummary), j.errorSummary);
  // 恢复
  r = await fetch(BASE + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE }),
  });
  cfg = await r.json();
  check('恢复路径后 ffmpeg 恢复可用', cfg.ffmpeg.ok === true);

  // 9. 清理预览
  r = await fetch(BASE + '/api/previews', { method: 'DELETE' });
  j = await r.json();
  check('清理预览文件', j.ok === true && j.removed >= 3, JSON.stringify(j));

  console.log(`\n--- 结果: ${passed} 通过, ${failed} 失败 ---`);
  return failed === 0;
}

main()
  .then((ok) => { server.kill(); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error('测试异常:', e); server.kill(); process.exit(1); });
