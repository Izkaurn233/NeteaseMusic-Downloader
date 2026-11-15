const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const api = require('./api');
const { pipeAudio } = require('./audio');
const { c, joinNames } = require('./format');
const { songTitle, withPrivileges, playbackLabel } = require('./music');

let current = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function playerPage(song, track, base) {
  const title = escapeHtml(songTitle(song));
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 音乐预览</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14151a;color:#f4f4f5;font:16px system-ui,sans-serif}
main{width:min(540px,calc(100% - 64px));padding:32px;background:#22242c;border-radius:20px}h1{font-size:24px;line-height:1.5}
p{color:#b8bac7;line-height:1.7}audio{width:100%;margin:20px 0}button{padding:10px 20px;border:0;border-radius:8px;cursor:pointer}
</style><main><p>♫ 网易云音乐 · 预览</p><h1>${title}</h1>
<p>${escapeHtml(joinNames(song.ar || song.artists))}</p><p>${escapeHtml(playbackLabel(track))}</p>
<audio controls autoplay preload="metadata" src="${base}/audio"></audio>
<p id="status">如果没有自动播放，请点击播放按钮。</p><button id="stop">停止预览</button></main>
<script>
const base = ${JSON.stringify(base)};
const audio = document.querySelector('audio');
const status = document.querySelector('#status');
const ping = setInterval(() => fetch(base + '/ping').catch(() => {
  clearInterval(ping); audio.pause(); status.textContent = '预览已停止，请从终端重新打开。';
}), 15000);
audio.addEventListener('error', () => { status.textContent = '音频暂时无法播放，请回到终端重试。'; });
document.querySelector('#stop').onclick = () => {
  audio.pause(); audio.hidden = true; audio.removeAttribute('src'); audio.load(); clearInterval(ping);
  fetch(base + '/close', {method:'POST'}).catch(() => {}); status.textContent = '预览已停止。';
};
window.addEventListener('pagehide', () => { navigator.sendBeacon(base + '/close'); });
</script></html>`;
}

function openUrl(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function stopPreview() {
  if (current) current.close();
}

async function startPreview(song, track, { open = true, idleMs = 60000 } = {}) {
  if (!track?.url) throw new Error('没有可用的预览地址（会员权限 / 版权限制）。');
  const audioUrl = new URL(track.url);
  if (!['http:', 'https:'].includes(audioUrl.protocol)) throw new Error('预览地址必须是 HTTP/HTTPS。');
  stopPreview();
  const base = '/' + crypto.randomBytes(18).toString('hex');
  let timer;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    if (server.closeAllConnections) server.closeAllConnections();
    if (current?.close === close) current = null;
  };
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(close, idleMs);
    timer.unref();
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === base + '/close' && req.method === 'POST') {
      res.writeHead(204).end();
      setImmediate(close);
      return;
    }
    if (req.method !== 'GET' || ![base, base + '/audio', base + '/ping'].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    touch();
    if (req.url === base) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(playerPage(song, track, base));
      return;
    }
    if (req.url.endsWith('/ping')) { res.writeHead(204).end(); return; }
    await pipeAudio(req, res, audioUrl);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}${base}`;
  current = { url, close };
  touch();
  if (open) {
    try { await openUrl(url); } catch (err) { close(); throw new Error(`无法打开预览播放器：${err.message}`); }
  }
  return { url, close };
}

async function previewSong(id, level = 'standard') {
  const [detail, urls] = await Promise.all([api.songDetail([id]), api.songUrl(id, level)]);
  const song = withPrivileges(detail.songs, detail.privileges)[0] || { name: String(id) };
  const track = urls.data?.[0];
  const player = await startPreview(song, track);
  process.stdout.write(`${c.cyan('♫')} ${songTitle(song)}  ${c.gray(playbackLabel(track))}\n`);
  process.stdout.write(c.gray(`已打开预览播放器：${player.url}\n关闭播放器页面可停止预览；命令行预览也可按 Ctrl+C 退出。\n`));
  return player;
}

module.exports = { previewSong, startPreview, stopPreview, openUrl };
