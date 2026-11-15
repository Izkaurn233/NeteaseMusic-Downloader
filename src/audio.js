const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { UA } = require('./request');

async function pipeAudio(req, res, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  const abort = () => controller.abort();
  res.once('close', abort);
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/', ...(req.headers.range ? { Range: req.headers.range } : {}) },
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) throw new Error(`音频请求失败 HTTP ${upstream.status}`);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.writeHead(upstream.status);
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('音频加载失败，请重新获取播放地址。');
    else res.destroy();
  } finally {
    clearTimeout(timeout);
    res.removeListener('close', abort);
  }
}

module.exports = { pipeAudio };
