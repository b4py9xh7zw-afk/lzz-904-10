'use strict';
/* 运动视频慢动作预览器 —— 前端逻辑 */
const $ = (id) => document.getElementById(id);
const state = { file: null, duration: 0, cfg: null, objUrl: null, timer: null };

/* ---------- 初始化：读取配置与 ffmpeg 状态 ---------- */
async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    state.cfg = cfg;
    $('cfgFfmpeg').value = cfg.ffmpegPath || '';
    $('cfgFfprobe').value = cfg.ffprobePath || '';
    renderFfmpegBadge(cfg);
    updateEstimate();
  } catch (e) {
    $('ffmpegBadge').textContent = '配置加载失败：' + e.message;
    $('ffmpegBadge').className = 'badge badge-err';
  }
}

function renderFfmpegBadge(cfg) {
  const b = $('ffmpegBadge');
  if (cfg.ffmpeg && cfg.ffmpeg.ok) {
    b.textContent = '✅ ' + (cfg.ffmpeg.version || 'ffmpeg 可用');
    b.className = 'badge badge-ok';
  } else {
    b.textContent = '❌ ffmpeg 不可用：' + (cfg.ffmpeg && cfg.ffmpeg.error ? cfg.ffmpeg.error : '未知');
    b.className = 'badge badge-err';
  }
}

/* ---------- 设置保存 ---------- */
$('btnSaveCfg').addEventListener('click', async () => {
  const btn = $('btnSaveCfg');
  btn.disabled = true;
  $('cfgResult').textContent = '保存并检测中…';
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ffmpegPath: $('cfgFfmpeg').value.trim(), ffprobePath: $('cfgFfprobe').value.trim() }),
    });
    const cfg = await r.json();
    state.cfg = cfg;
    renderFfmpegBadge(cfg);
    let msg = '';
    msg += cfg.ffmpeg.ok ? '✅ ffmpeg：' + cfg.ffmpeg.version + '\n' : '❌ ffmpeg：' + cfg.ffmpeg.error + '\n';
    msg += cfg.ffprobe.ok ? '✅ ffprobe：' + cfg.ffprobe.version : '⚠️ ffprobe：' + cfg.ffprobe.error + '（缺失时仍可生成预览，但无法自动识别帧率/时长）';
    $('cfgResult').textContent = msg;
  } catch (e) {
    $('cfgResult').textContent = '保存失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
});

$('btnClear').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/previews', { method: 'DELETE' });
    const j = await r.json();
    $('cfgResult').textContent = '已清理 ' + j.removed + ' 个预览文件';
  } catch (e) {
    $('cfgResult').textContent = '清理失败：' + e.message;
  }
});

/* ---------- 文件选择与本地元信息 ---------- */
const fileInput = $('fileInput');
const dropZone = $('dropZone');

fileInput.addEventListener('change', () => { if (fileInput.files[0]) pickFile(fileInput.files[0]); });
['dragover', 'dragenter'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) pickFile(f);
});

function pickFile(file) {
  if (state.cfg && file.size > state.cfg.maxUploadMB * 1024 * 1024) {
    alert('文件超过上传上限 ' + state.cfg.maxUploadMB + 'MB');
    return;
  }
  state.file = file;
  $('fileHint').textContent = file.name + '（' + (file.size / 1024 / 1024).toFixed(1) + ' MB）';
  if (state.objUrl) URL.revokeObjectURL(state.objUrl);
  state.objUrl = URL.createObjectURL(file);
  const player = $('srcPlayer');
  player.src = state.objUrl;
  player.classList.remove('hidden');
  player.onloadedmetadata = () => {
    state.duration = player.duration || 0;
    $('srcMeta').textContent = '时长 ' + state.duration.toFixed(2) + 's · ' +
      player.videoWidth + '×' + player.videoHeight;
    $('startSec').value = '0';
    const maxSeg = (state.cfg && state.cfg.maxSegmentSeconds) || 15;
    $('endSec').value = Math.min(maxSeg, Math.max(1, Math.ceil(state.duration * 10) / 10)).toFixed(1);
    $('btnGo').disabled = false;
    updateEstimate();
  };
}

/* ---------- 参数联动 ---------- */
$('speed').addEventListener('input', updateEstimate);
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
  $('speed').value = c.dataset.speed;
  updateEstimate();
}));
['startSec', 'endSec', 'targetFps'].forEach((id) => $(id).addEventListener('input', updateEstimate));

$('markStart').addEventListener('click', () => {
  $('startSec').value = $('srcPlayer').currentTime.toFixed(1);
  updateEstimate();
});
$('markEnd').addEventListener('click', () => {
  $('endSec').value = $('srcPlayer').currentTime.toFixed(1);
  updateEstimate();
});

function updateEstimate() {
  const speed = parseFloat($('speed').value);
  $('speedLabel').textContent = speed.toFixed(2) + '×';
  $('slowFactor').textContent = '（时长变为 ' + (1 / speed).toFixed(1) + ' 倍）';
  const start = parseFloat($('startSec').value) || 0;
  const end = parseFloat($('endSec').value) || 0;
  const maxSeg = (state.cfg && state.cfg.maxSegmentSeconds) || 15;
  let msg = '';
  if (state.duration) {
    $('segHint').textContent = '视频全长 ' + state.duration.toFixed(1) + 's，单次预览最长 ' + maxSeg + 's';
    if (end > start) {
      const seg = Math.min(end - start, maxSeg);
      msg = '📏 预览片段 ' + seg.toFixed(1) + 's → 慢放后约 ' + (seg / speed).toFixed(1) + 's';
      if (end - start > maxSeg) msg += '（超出上限，将截断）';
    } else {
      msg = '⚠️ 结束时间需大于开始时间';
    }
  }
  $('estimate').textContent = msg;
}

/* ---------- 提交生成 ---------- */
$('btnGo').addEventListener('click', async () => {
  if (!state.file) return;
  const start = parseFloat($('startSec').value) || 0;
  const end = parseFloat($('endSec').value);
  if (!(end > start)) { alert('请填写正确的裁剪时间段（结束 > 开始）'); return; }

  const fd = new FormData();
  fd.append('video', state.file, state.file.name);
  fd.append('speed', $('speed').value);
  fd.append('interpolation', document.querySelector('input[name=interp]:checked').value);
  fd.append('resolution', $('resolution').value);
  fd.append('start', String(start));
  fd.append('end', String(end));
  fd.append('keepAudio', $('keepAudio').checked ? '1' : '0');
  if ($('targetFps').value) fd.append('targetFps', $('targetFps').value);

  $('btnGo').disabled = true;
  $('progress').classList.remove('hidden');
  const t0 = performance.now();
  state.timer = setInterval(() => {
    $('elapsedNow').textContent = ((performance.now() - t0) / 1000).toFixed(1);
  }, 100);

  try {
    const r = await fetch('/api/preview', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok && !j.command) {
      showErrorOnly(j.error || ('HTTP ' + r.status));
    } else {
      renderResult(j, performance.now() - t0);
    }
  } catch (e) {
    showErrorOnly('请求失败：' + e.message);
  } finally {
    clearInterval(state.timer);
    $('progress').classList.add('hidden');
    $('btnGo').disabled = false;
  }
});

function showErrorOnly(msg) {
  $('resultEmpty').classList.add('hidden');
  $('resultBody').classList.remove('hidden');
  $('statusBadge').textContent = '❌ 失败';
  $('statusBadge').className = 'badge badge-err';
  $('cmdText').textContent = '（未执行）';
  $('elapsedText').textContent = '—';
  $('errorBox').classList.remove('hidden');
  $('errorText').textContent = msg;
  $('previewBox').classList.add('hidden');
  $('warnBox').classList.add('hidden');
  $('stderrText').textContent = '';
}

/* ---------- 结果渲染 ---------- */
function renderResult(j, clientMs) {
  $('resultEmpty').classList.add('hidden');
  $('resultBody').classList.remove('hidden');

  $('statusBadge').textContent = j.ok ? '✅ 生成成功' : '❌ 生成失败';
  $('statusBadge').className = 'badge ' + (j.ok ? 'badge-ok' : 'badge-err');

  $('cmdText').textContent = j.command || '（无）';

  let el = '后端处理 ' + (j.elapsedMs / 1000).toFixed(2) + 's';
  el += ' · 请求总计 ' + (clientMs / 1000).toFixed(2) + 's';
  $('elapsedText').textContent = el;

  if (j.ok) {
    $('errorBox').classList.add('hidden');
    $('previewBox').classList.remove('hidden');
    const player = $('previewPlayer');
    player.src = j.previewUrl + '?t=' + Date.now();
    $('downloadLink').href = j.previewUrl;
    $('downloadLink').setAttribute('download', j.downloadName || 'slowmo.mp4');
    let info = '';
    if (j.params) info += '输出约 ' + j.params.expectedOutputSeconds + 's · ' + j.params.targetFps + 'fps';
    if (j.outputBytes) info += ' · ' + (j.outputBytes / 1024 / 1024).toFixed(2) + ' MB';
    $('outputInfo').textContent = info;
  } else {
    $('previewBox').classList.add('hidden');
    $('errorBox').classList.remove('hidden');
    $('errorText').textContent = j.errorSummary || '未知错误';
  }

  if (j.warnings && j.warnings.length) {
    $('warnBox').classList.remove('hidden');
    $('warnList').innerHTML = j.warnings.map((w) => '<li>' + escapeHtml(w) + '</li>').join('');
  } else {
    $('warnBox').classList.add('hidden');
  }

  $('stderrText').textContent = j.stderrTail || '（无输出）';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('btnCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('cmdText').textContent);
    $('btnCopy').textContent = '已复制 ✓';
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = $('cmdText').textContent;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    $('btnCopy').textContent = '已复制 ✓';
  }
  setTimeout(() => { $('btnCopy').textContent = '复制'; }, 1500);
});

loadConfig();
