'use strict';
const crypto = require('crypto');

/** 生成唯一 ID（用于上传文件与预览文件命名） */
function genId() {
  return Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
}

/** 清洗用户上传的文件名：去掉路径、保留中英文/数字/点/横线/下划线 */
function sanitizeFilename(name) {
  const base = String(name || 'video').replace(/\\/g, '/').split('/').pop();
  const cleaned = base.replace(/[^\w.\-一-龥]+/g, '_');
  return cleaned.slice(-80) || 'video';
}

/** 秒数格式化为 ffmpeg 参数（去掉多余 0） */
function fmtSec(n) {
  const s = Number(n).toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
}

/** 命令行展示用：含空白或特殊字符的参数加双引号 */
function quoteArg(arg) {
  const s = String(arg);
  if (/[\s"'&|<>^%$`]/.test(s)) {
    return '"' + s.replace(/"/g, '\\"') + '"';
  }
  return s;
}

/** 把 argv 拼成可读的命令字符串 */
function buildCommandString(bin, argv) {
  return [quoteArg(bin), ...argv.map(quoteArg)].join(' ');
}

/** 统一 JSON 响应 */
function json(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读取请求体（带大小限制） */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limitBytes) {
        done = true;
        const err = new Error('请求体超过大小限制');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

/** 截取 stderr 尾部若干行 */
function tailLines(text, maxLines, maxChars) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  let tail = lines.slice(-maxLines).join('\n');
  if (tail.length > maxChars) tail = tail.slice(-maxChars);
  return tail;
}

module.exports = { genId, sanitizeFilename, fmtSec, quoteArg, buildCommandString, json, readBody, tailLines };
