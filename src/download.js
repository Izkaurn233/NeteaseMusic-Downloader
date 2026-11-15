const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { size } = require('./format');

const EXT_RE = /\.(mp3|flac|m4a|aac|wav|ogg|ape)(?:\?|$)/i;

function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150);
}

function extFromUrl(url, type) {
  const m = String(url).match(EXT_RE);
  if (m) return m[1].toLowerCase();
  return type || 'mp3';
}

async function downloadTo(url, filePath, { quiet = false } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Referer: 'https://music.163.com/',
    },
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  let lastPrint = 0;

  if (!quiet && process.stderr.isTTY && total) {
    const tick = setInterval(() => {
      const pct = ((received / total) * 100).toFixed(1);
      const bar = '█'.repeat(Math.round((received / total) * 24)).padEnd(24, '░');
      process.stderr.write(`\r  ${bar} ${pct}%  ${size(received)} / ${size(total)}   `);
    }, 200);
    tick.unref();
    try {
      await streamTo(res.body, filePath, (n) => (received += n));
    } finally {
      clearInterval(tick);
      process.stderr.write('\r' + ' '.repeat(70) + '\r');
    }
  } else {
    await streamTo(res.body, filePath, (n) => (received += n));
  }

  return { bytes: received || fs.statSync(filePath).size, total };
}

async function streamTo(webStream, filePath, onChunk) {
  const source = Readable.fromWeb(webStream);
  source.on('data', (chunk) => onChunk(chunk.length));
  await pipeline(source, fs.createWriteStream(filePath));
}

function resolvePath(dir, name, ext) {
  const dirPath = path.resolve(dir);
  fs.mkdirSync(dirPath, { recursive: true });
  let base = sanitize(name) || 'untitled';
  let target = path.join(dirPath, `${base}.${ext}`);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(dirPath, `${base} (${i++}).${ext}`);
  }
  return target;
}

module.exports = { downloadTo, resolvePath, sanitize, extFromUrl };
