'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

/** 默认配置：Win10 上把 ffmpegPath 改成例如 C:\\ffmpeg\\bin\\ffmpeg.exe */
const DEFAULTS = {
  ffmpegPath: 'ffmpeg',        // ffmpeg 可执行文件路径（Win10 示例: C:\\ffmpeg\\bin\\ffmpeg.exe）
  ffprobePath: 'ffprobe',      // ffprobe 可执行文件路径
  host: '0.0.0.0',
  port: 8321,
  maxUploadMB: 300,            // 上传大小上限
  maxSegmentSeconds: 15,       // 预览裁剪时间段最长秒数（保证“短预览”）
  jobTimeoutSeconds: 600,      // 单次 ffmpeg 任务超时
  previewTtlMinutes: 120,      // 预览文件保留时长（0 = 不自动清理）
};

let cache = null;

function load() {
  if (cache) return cache;
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) { /* 文件不存在或损坏时使用默认值 */ }
  cache = Object.assign({}, DEFAULTS, user);
  if (process.env.PORT) cache.port = Number(process.env.PORT) || cache.port;
  return cache;
}

/** 保存（部分更新），返回最新配置 */
function save(patch) {
  const cur = load();
  const next = Object.assign({}, cur);
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] !== undefined && patch[key] !== null && patch[key] !== '') {
      next[key] = patch[key];
    }
  }
  // 数值字段兜底
  for (const k of ['port', 'maxUploadMB', 'maxSegmentSeconds', 'jobTimeoutSeconds', 'previewTtlMinutes']) {
    next[k] = Number(next[k]);
    if (!Number.isFinite(next[k]) || next[k] < 0) next[k] = DEFAULTS[k];
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  cache = next;
  return cache;
}

module.exports = { load, save, DEFAULTS, CONFIG_FILE };
