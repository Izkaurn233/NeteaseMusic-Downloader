const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const api = require('./api');
const { songId } = require('./parse');
const { loadConfig } = require('./config');
const { LEVELS, LEVEL_LABEL, withPrivileges, songBadge, trialLabel, playbackLabel } = require('./music');
const { extFromUrl, sanitize } = require('./download');
const { joinNames } = require('./format');
const { openUrl } = require('./preview');
const { pipeAudio } = require('./audio');

const WEB_DIR = path.join(__dirname, '..', 'web');
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };

function songView(song) {
  return {
    id: String(song.id), name: song.name || '未知歌曲', artist: joinNames(song.ar || song.artists),
    album: (song.al || song.album || {}).name || '', cover: (song.al || song.album || {}).picUrl || '',
    duration: song.dt || song.duration || 0, badge: songBadge(song),
  };
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) throw new Error('输入内容过长。');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text || '{}'); } catch { throw new Error('请求内容不是有效 JSON。'); }
}

async function getSong(input) {
  const id = await songId(input);
  const res = await api.songDetail([id]);
  const song = withPrivileges(res.songs, res.privileges)[0];
  if (!song) throw new Error('没有找到这首歌曲。');
  return song;
}

async function startWeb({ port = 0, open = true } = {}) {
  const sessionToken = crypto.randomBytes(24).toString('hex');
  const tickets = new Map();
  const prune = () => {
    for (const [key, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(key);
    while (tickets.size > 100) tickets.delete(tickets.keys().next().value);
  };
  const remember = (track, filename) => {
    prune();
    const url = new URL(track.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('音频地址无效。');
    const key = crypto.randomBytes(18).toString('hex');
    tickets.set(key, { url: url.href, filename, expires: Date.now() + Math.max(1, Math.min(Number(track.expi) || 600, 600)) * 1000 });
    prune();
    return (filename ? '/download/' : '/media/') + key;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const allowed = [`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`];
    if (!allowed.includes(req.headers.host)) { res.writeHead(421).end(); return; }
    const url = new URL(req.url, 'http://' + req.headers.host);
    const route = url.pathname;
    try {
      if (req.method === 'GET' && FILES[route]) {
        const [file, type] = FILES[route];
        const body = fs.readFileSync(path.join(WEB_DIR, file), 'utf8').replace('__NJ_TOKEN__', sessionToken);
        res.writeHead(200, { 'Content-Type': type }).end(body);
        return;
      }
      if (req.method === 'GET' && /^\/(media|download)\/[0-9a-f]+$/.test(route)) {
        prune();
        const ticket = tickets.get(route.split('/')[2]);
        if (!ticket || Boolean(ticket.filename) !== route.startsWith('/download/')) throw new Error('播放地址已过期，请重新点击预览或下载。');
        if (ticket.filename) {
          const fallback = ticket.filename.replace(/[^a-zA-Z0-9.() _-]/g, '_');
          res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(ticket.filename).replace(/['()]/g, (ch) => '%' + ch.charCodeAt(0).toString(16))}`);
        }
        await pipeAudio(req, res, ticket.url);
        return;
      }
      if (!route.startsWith('/api/')) { res.writeHead(404).end(); return; }
      if (req.headers['x-nj-token'] !== sessionToken) { sendJson(res, { error: '请从本机启动页访问。' }, 403); return; }
      if (route === '/api/status' && req.method === 'GET') {
        const cfg = loadConfig();
        sendJson(res, { loggedIn: Boolean((cfg.cookie || '').match(/(?:^|;\s*)MUSIC_U=[^;]+/)), profile: cfg.profile || null, levels: LEVEL_LABEL });
        return;
      }
      if (route === '/api/search' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q || q.length > 1000) throw new Error('请输入歌曲名称、歌手、歌曲 ID 或链接。');
        if (/^\d{3,}$/.test(q) || /https?:\/\/|163cn\.tv/.test(q)) {
          const song = await getSong(q);
          sendJson(res, { songs: [songView(song)], total: 1, direct: true });
        } else {
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          const result = await api.search(q, { limit: 20, offset });
          sendJson(res, { songs: withPrivileges(result.result?.songs, result.result?.privileges).map(songView), total: result.result?.songCount || 0, direct: false });
        }
        return;
      }
      if (route === '/api/lyric' && req.method === 'GET') {
        const id = await songId(url.searchParams.get('id'));
        const result = await api.lyric(id);
        sendJson(res, { lyric: result.lrc?.lyric || '', translation: result.tlyric?.lyric || '' });
        return;
      }
      if (['/api/playback', '/api/download'].includes(route) && req.method === 'POST') {
        const body = await readJson(req);
        const level = body.level || (route === '/api/playback' ? 'standard' : 'lossless');
        if (!LEVELS.includes(level)) throw new Error('请选择有效的音质。');
        const song = await getSong(body.input);
        const result = await api.songUrl(song.id, level);
        const track = result.data?.[0];
        if (!track?.url) throw new Error('这首歌曲暂无可用音频，可能没有试听资源或受到版权、账号权限限制。');
        const trial = trialLabel(track);
        const filename = sanitize(`${joinNames(song.ar || song.artists) || 'unknown'} - ${song.name}${trial ? ` (${trial})` : ''}`) + '.' + extFromUrl(track.url, track.type);
        sendJson(res, {
          song: songView(song), mediaUrl: remember(track, route === '/api/download' ? filename : null),
          filename, quality: playbackLabel(track) || LEVEL_LABEL[level], trial,
          downgraded: Boolean(track.level && track.level !== level),
        });
        return;
      }
      sendJson(res, { error: '没有这个接口。' }, 404);
    } catch (err) {
      if (!res.headersSent) sendJson(res, { error: err.message || '请求失败，请重试。' }, 400);
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => { server.close(); if (server.closeAllConnections) server.closeAllConnections(); tickets.clear(); };
  if (open) await openUrl(url).catch((err) => process.stderr.write(`浏览器未能自动打开，请手动访问 ${url}（${err.message}）\n`));
  return { url, close };
}

module.exports = { startWeb };
