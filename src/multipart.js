'use strict';

/**
 * 极简 multipart/form-data 解析（二进制安全，整体缓冲——上传大小由服务端限制）。
 * 返回 { fields: {name: value}, files: [{ name, filename, contentType, data: Buffer }] }
 */
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw Object.assign(new Error('缺少 multipart boundary'), { status: 400 });
  const boundary = m[1] || m[2];
  const delimiter = Buffer.from('--' + boundary);

  const fields = {};
  const files = [];

  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    const next = body.indexOf(delimiter, pos + delimiter.length);
    if (next === -1) break;
    let part = body.slice(pos + delimiter.length, next);
    pos = next;

    // 结尾标记 "--"
    if (part.length >= 2 && part[0] === 0x2d && part[1] === 0x2d) break;
    // 去掉开头 CRLF 与结尾 CRLF
    if (part.length >= 2 && part[0] === 0x0d && part[1] === 0x0a) part = part.slice(2);
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.slice(0, part.length - 2);
    }
    if (part.length === 0) continue;

    const sep = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sep === -1) continue;
    const rawHeaders = part.slice(0, sep).toString('utf8');
    const data = part.slice(sep + 4);

    const headers = {};
    for (const line of rawHeaders.split(/\r\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    const disp = headers['content-disposition'] || '';
    const nameM = /name="([^"]*)"/.exec(disp);
    if (!nameM) continue;
    const name = nameM[1];
    const fileM = /filename="([^"]*)"/.exec(disp) || /filename\*=UTF-8''([^;]+)/.exec(disp);

    if (fileM && fileM[1] !== '') {
      files.push({
        name,
        filename: decodeURIComponent(fileM[1]),
        contentType: headers['content-type'] || 'application/octet-stream',
        data,
      });
    } else {
      fields[name] = data.toString('utf8');
    }
  }
  return { fields, files };
}

module.exports = { parseMultipart };
