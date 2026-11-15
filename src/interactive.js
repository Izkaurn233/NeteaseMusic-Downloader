const readline = require('readline');
const path = require('path');
const api = require('./api');
const login = require('./login');
const { isLoggedIn } = require('./request');
const { loadConfig } = require('./config');
const { c, duration, size, joinNames, truncate, width } = require('./format');
const { downloadTo, resolvePath, extFromUrl } = require('./download');
const { LEVELS, LEVEL_LABEL, withPrivileges, songBadge, songTitle, trialLabel, playbackLabel, chooseDownloadLevel } = require('./music');
const { previewSong, stopPreview } = require('./preview');

const PAGE = 10;
let isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
let downloadLevel = 'lossless';

function row(kind, item) {
  if (kind === 'song') {
    return {
      kind,
      id: String(item.id),
      name: item.name,
      badge: songBadge(item),
      sub: `${joinNames(item.ar || item.artists)}${(item.al || item.album || {}).name ? ' · ' + (item.al || item.album).name : ''}`,
      time: duration(item.dt || item.duration),
    };
  }
  if (kind === 'playlist') {
    return {
      kind,
      id: String(item.id),
      name: item.name,
      sub: `歌单 · ${item.creator?.nickname || '-'} · ${item.trackCount ?? '-'} 首`,
      time: '',
    };
  }
  if (kind === 'album') {
    return {
      kind,
      id: String(item.id),
      name: item.name,
      sub: `专辑 · ${joinNames(item.artists)} · ${item.size ?? '-'} 首`,
      time: '',
    };
  }
  return {
    kind,
    id: String(item.id),
    name: item.name,
    sub: `歌手 · ${(item.alias || []).join('/') || '-'} · ${item.albumSize ?? '-'} 张专辑`,
    time: '',
  };
}

function frame(title, rows, extra = {}) {
  return { title, rows, page: 0, cursor: 0, ...extra };
}

function clampPage(f) {
  const total = Math.max(1, Math.ceil(f.rows.length / PAGE));
  f.page = Math.min(Math.max(0, f.page), total - 1);
  return total;
}

function pageRows(f) {
  clampPage(f);
  return f.rows.slice(f.page * PAGE, f.page * PAGE + PAGE);
}

function renderRows(f) {
  const rows = pageRows(f);
  return rows.map((r, i) => {
    const idx = f.page * PAGE + i + 1;
    const left = c.gray(String(idx).padStart(2) + '.');
    const badge = r.badge ? r.badge + ' ' : '';
    const available = Math.max(8, (process.stdout.columns || 140) - width(badge) - width(left) - width(r.time) - 6);
    const name = badge + truncate(r.name, Math.min(34, available));
    const nameW = width(name);
    const pad = ' '.repeat(Math.max(2, 36 - nameW));
    const subWidth = Math.max(0, available - width(name) + width(badge) - width(pad));
    const sub = subWidth > 4 ? c.gray(truncate(r.sub, Math.min(40, subWidth))) : '';
    return `${left} ${name}${pad}${sub}${r.time ? '  ' + c.gray(r.time) : ''}`;
  });
}

function topLine(f, total) {
  return `${c.bold(truncate(f.title, 44))}  ${c.gray(`${f.rows.length} 条 · 第 ${f.page + 1}/${total} 页`)}`;
}

function banner() {
  const cfg = loadConfig();
  const who = isLoggedIn()
    ? cfg.profile
      ? `${cfg.profile.nickname}${cfg.profile.vip ? ' · ' + cfg.profile.vipLabel : ' · 非会员'}`
      : '已保存 Cookie'
    : c.yellow('未登录（VIP 歌曲需要登录）');
  process.stdout.write(
    `\n${c.cyan('♫')} ${c.bold('网易云音乐 · 本地交互模式')}   ${c.gray('账号:')} ${who}\n` +
      c.gray('  输入关键词搜索，或粘贴歌曲 ID / 歌曲链接 / 分享文本；结果里用 ↑↓ 选择、回车打开\n') +
      c.gray(`  p 预览   s 停止   u 直链   l 歌词   d 选择音质下载   D 下载当前列表   b 返回   q 退出   ${'音质:' + downloadLevel}\n`) +
      c.gray('  命令: /login  /whoami  /logout  /level lossless  /type song|album|artist|playlist  /page N  /help  /quit\n\n'),
  );
}

function helpText() {
  process.stdout.write(`
${c.bold('搜索')}
  直接输入关键词                     按当前类型搜索
  歌曲 ID / 歌曲链接 / 分享文本      直接打开歌曲详情，再按 p 预览或 d 下载
  /type song|album|artist|playlist   切换搜索类型（默认 song）
  /page 2                            翻到第 2 页

${c.bold('列表里')}
  ↑ / ↓（或 k / j）                  移动
  Enter                              打开（歌曲详情 / 歌单 / 专辑 / 歌手）
  u  l  d                            直链 / 歌词 / 下载选中的那首
  p / s                              预览选中歌曲 / 停止预览（非 TTY 用 p <序号>）
  d                                  选择音质后下载；D 为整张列表选择一次音质
  D                                  下载当前列表全部歌曲
  [ ]  或 ← →                        上一页 / 下一页
  b  或  Esc                         返回上一级
  /                                  重新搜索
  q                                  退出

${c.bold('歌曲详情页')}
  p 预览   s 停止   u 取直链   l 歌词   d 选择音质下载   o 浏览器打开   b 返回

${c.bold('账号')}
  /login                             登录（手机号密码 / 短信码 / 扫码 / Cookie，任选）
  /whoami                            当前账号与会员状态
  /logout                            退出登录（清本地 Cookie）
  /stop                              停止预览
  /level [lossless]                  默认下载音质（不带参数打开菜单）

${c.bold('命令行')}
  /help   帮助        /quit   退出
`);
}

function makeQuestion(rl) {
  // 非 TTY（管道/文件重定向）时 readline 会把所有行一次性吐出来，
  // 这里先入队再逐条交付，避免后续命令被丢掉。
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  return {
    isClosed: () => closed && !queue.length,
    ask: (q) =>
      new Promise((resolve) => {
        if (queue.length) return resolve(queue.shift());
        if (closed) return resolve(null);
        process.stdout.write(q);
        waiters.push(resolve);
      }),
  };
}

function askLineTTY(promptText) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    process.stdin.resume();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(promptText, (ans) => {
      finish(ans);
      rl.close();
    });
    rl.on('close', () => finish(null));
  });
}

async function doSearch(keywords, type) {
  const res = await api.search(keywords, { type, limit: 30 });
  const r = res.result || {};
  if (type === 'song') return frame(`搜索「${keywords}」`, withPrivileges(r.songs, r.privileges).map((s) => row('song', s)), { type });
  if (type === 'playlist') return frame(`搜索「${keywords}」`, (r.playlists || []).map((p) => row('playlist', p)), { type });
  if (type === 'album') return frame(`搜索「${keywords}」`, (r.albums || []).map((a) => row('album', a)), { type });
  return frame(`搜索「${keywords}」`, (r.artists || []).map((a) => row('artist', a)), { type });
}

async function drill(item, stack) {
  if (item.kind === 'playlist') {
    const res = await api.playlistDetail(item.id, 500);
    const pl = res.playlist;
    stack.push(frame(`歌单「${pl.name}」`, withPrivileges(pl.tracks, res.privileges || pl.privileges).map((s) => row('song', s)), { type: 'song', list: true }));
  } else if (item.kind === 'album') {
    const res = await api.album(item.id);
    const songs = (res.album?.songs?.length ? res.album.songs : res.songs) || [];
    stack.push(frame(`专辑「${res.album?.name || item.name}」`, withPrivileges(songs, res.privileges).map((s) => row('song', s)), { type: 'song', list: true }));
  } else if (item.kind === 'artist') {
    const res = await api.artist(item.id);
    stack.push(frame(`歌手「${res.artist?.name || item.name}」热门`, withPrivileges(res.hotSongs, res.privileges).map((s) => row('song', s)), { type: 'song', list: true }));
  }
}

function printSongDetail(song) {
  const al = song.al || {};
  process.stdout.write(
    `\n${c.bold(songTitle(song))}\n` +
      `  ${c.gray('歌手')}  ${joinNames(song.ar)}\n` +
      `  ${c.gray('专辑')}  ${al.name || '-'}\n` +
      `  ${c.gray('时长')}  ${duration(song.dt)}\n` +
      `  ${c.gray('ID')}    ${song.id}\n` +
      `  ${c.gray('链接')}  ${c.blue(`https://music.163.com/song?id=${song.id}`)}\n\n` +
      `  ${c.gray('[p] 预览  [s] 停止  [u] 直链  [l] 歌词  [d] 选择音质下载  [o] 浏览器打开  [b] 返回')}\n`,
  );
}

async function showUrl(id, level = downloadLevel) {
  const [detail, urls] = await Promise.all([api.songDetail([id]).catch(() => null), api.songUrl(id, level)]);
  const song = withPrivileges(detail?.songs, detail?.privileges)[0];
  const track = urls.data?.[0] || {};
  if (song) process.stdout.write(`${c.bold(songTitle(song))} ${c.gray('—')} ${joinNames(song.ar)}\n`);
  if (!track.url) {
    process.stdout.write(c.yellow('没有可用播放地址（VIP/版权/未登录）\n'));
    return;
  }
  if (trialLabel(track)) process.stdout.write(c.yellow(`⚠ ${trialLabel(track)}（接口实际返回的片段）\n`));
  process.stdout.write(`  ${c.gray('音质')} ${track.level} · ${track.type?.toUpperCase()} · ${Math.round((track.br || 0) / 1000)}kbps · ${size(track.size)}\n`);
  process.stdout.write(`  ${c.cyan(track.url)}\n`);
}

async function showLyric(id, trans = true) {
  const res = await api.lyric(id);
  const lrc = res.lrc?.lyric || '';
  const tlrc = trans ? res.tlyric?.lyric || '' : '';
  if (!lrc.trim()) {
    process.stdout.write(c.yellow('没有歌词\n'));
    return;
  }
  if (!tlrc) {
    process.stdout.write(lrc + '\n');
    return;
  }
  const map = new Map();
  for (const line of tlrc.split('\n')) {
    const m = line.match(/^\[(\d+:\d+(?:\.\d+)?)\](.*)$/);
    if (m && m[2].trim()) map.set(m[1], m[2].trim());
  }
  process.stdout.write(
    lrc
      .split('\n')
      .map((line) => {
        const m = line.match(/^\[(\d+:\d+(?:\.\d+)?)\](.*)$/);
        if (m && map.has(m[1])) return `${line}\n${c.gray(`[${m[1]}]${map.get(m[1])}`)}`;
        return line;
      })
      .join('\n') + '\n',
  );
}

async function downloadSong(id, dir = './downloads', level = downloadLevel) {
  try {
    const [detail, urls] = await Promise.all([api.songDetail([id]).catch(() => ({ songs: [] })), api.songUrl(id, level)]);
    const song = withPrivileges(detail.songs, detail.privileges)[0];
    const track = urls.data?.[0];
    const label = song ? `${joinNames(song.ar)} - ${song.name}` : id;
    if (!track?.url) {
      process.stdout.write(
        c.yellow(`✗ ${label}  无可用地址${track?.freeTrialInfo ? '（只有试听片段）' : ''}`) +
          (isLoggedIn() ? c.gray('  当前账号无会员权限或该曲受限\n') : c.gray('  未登录，先 /login\n')),
      );
      return false;
    }
    if (songBadge(song)) process.stdout.write(c.yellow(`${songBadge(song)} ${label}\n`));
    const trial = trialLabel(track);
    if (trial) process.stdout.write(c.yellow(`⚠ 当前仅能下载${trial}，不会保存为完整版。\n`));
    const ext = extFromUrl(track.url, track.type || 'mp3');
    const file = resolvePath(dir, label + (trial ? ` (${trial})` : ''), ext);
    process.stdout.write(`${c.cyan('↓')} ${path.basename(file)}  `);
    const { bytes } = await downloadTo(track.url, file, { quiet: !isTTY });
    process.stdout.write(c.green(`✓ ${size(bytes)} · ${playbackLabel(track) || LEVEL_LABEL[level]}`) + '\n');
    return true;
  } catch (err) {
    process.stdout.write(c.red(`✗ ${id}  ${err.message}`) + '\n');
    return false;
  }
}

async function openBrowser(id) {
  const url = `https://music.163.com/song?id=${id}`;
  const { spawn } = require('child_process');
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  process.stdout.write(c.gray(`已在浏览器打开 ${url}\n`));
}

async function detailView(song, ask) {
  printSongDetail(song);
  for (;;) {
    const ans = await (isTTY ? waitKey('  > ') : ask('  > '));
    if (ans === null) return;
    const cmd = isTTY ? ans : String(ans).trim().toLowerCase();
    if (!isTTY && cmd === '') continue;
    if (cmd === 'b' || cmd === 'q' || cmd === 'esc' || cmd === 'escape') return;
    try {
      if (cmd === 'p') await previewSong(song.id);
      else if (cmd === 's') { stopPreview(); process.stdout.write(c.gray('已停止预览。\n')); }
      else if (cmd === 'u') await showUrl(song.id);
      else if (cmd === 'l') await showLyric(song.id);
      else if (cmd === 'd') {
        const level = await chooseDownloadLevel(ask, downloadLevel);
        if (level) { downloadLevel = level; await downloadSong(song.id, './downloads', level); }
      }
      else if (cmd === 'o') await openBrowser(song.id);
      else process.stdout.write(c.gray('  p 预览 / s 停止 / u 直链 / l 歌词 / d 下载 / o 浏览器 / b 返回\n'));
    } catch (err) { process.stdout.write(c.red(`操作失败: ${err.message}\n`)); }
    if (isTTY) process.stdout.write(c.gray(`\n  [p] 预览  [s] 停止  [u] 直链  [l] 歌词  [d] 下载  [o] 浏览器  [b] 返回\n`));
  }
}

function waitKey(promptText) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(promptText);
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch {
      return resolve('b');
    }
    stdin.resume();
    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }
      cleanup();
      if (key.name === 'return') return resolve('enter');
      if (key.name === 'escape') return resolve('b');
      resolve(str);
    };
    const cleanup = () => {
      stdin.removeListener('keypress', onKey);
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch {}
    };
    stdin.on('keypress', onKey);
  });
}

function paint(state, lines) {
  if (state.drawn > 0) process.stdout.write(`\x1b[${state.drawn}A`);
  for (const line of lines) process.stdout.write('\x1b[2K' + line + '\n');
  if (state.drawn > lines.length) {
    for (let i = lines.length; i < state.drawn; i++) process.stdout.write('\x1b[2K\n');
    process.stdout.write(`\x1b[${state.drawn - lines.length}A`);
  }
  state.drawn = lines.length;
}

function browseRaw(f) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch {
      isTTY = false;
      return resolve({ action: 'fallback' });
    }
    stdin.resume();

    const state = { drawn: 0 };
    const total = clampPage(f);
    if (f.cursor >= f.rows.length) f.cursor = 0;

    const draw = () => {
      const lines = [topLine(f, total)];
      const start = f.page * PAGE;
      const rendered = renderRows(f);
      pageRows(f).forEach((r, i) => {
        const idx = start + i;
        const base = rendered[i];
        lines.push(idx === f.cursor ? `\x1b[7m${base.replace(/\x1b\[[0-9;]*m/g, '')}\x1b[0m` : base);
      });
      if (!f.rows.length) lines.push(c.gray('  没有结果'));
      lines.push('');
      lines.push(
        c.gray('  ↑↓ 选择 · Enter 打开 · p 预览 · s 停止 · u 直链 · l 歌词 · d 选音质下载') +
          (f.rows.some((r) => r.kind === 'song') ? c.gray(' · D 全部下载') : '') +
          c.gray(' · b 返回 · / 搜索 · q 退出'),
      );
      paint(state, lines);
    };
    draw();

    const finish = (result) => {
      stdin.removeListener('keypress', onKey);
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch {}
      stdin.pause();
      process.stdout.write('\n');
      resolve(result);
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        stdin.removeListener('keypress', onKey);
        process.stdout.write('\n');
        process.exit(0);
      }
      const name = key.name;
      switch (true) {
        case name === 'up' || str === 'k':
          f.cursor = (f.cursor - 1 + f.rows.length) % Math.max(1, f.rows.length);
          if (f.cursor < f.page * PAGE) f.page = Math.floor(f.cursor / PAGE);
          return draw();
        case name === 'down' || str === 'j':
          f.cursor = (f.cursor + 1) % Math.max(1, f.rows.length);
          if (f.cursor >= (f.page + 1) * PAGE) f.page = Math.floor(f.cursor / PAGE);
          return draw();
        case name === 'left' || str === '[':
          if (f.page > 0) f.page--;
          f.cursor = Math.min(f.cursor, f.page * PAGE + PAGE - 1);
          return draw();
        case name === 'right' || str === ']':
          if (f.page < total - 1) f.page++;
          f.cursor = Math.max(f.cursor, f.page * PAGE);
          return draw();
        case name === 'return':
          return f.rows[f.cursor] ? finish({ action: 'open', index: f.cursor }) : draw();
        case str === 'u':
          return finish({ action: 'url', index: f.cursor });
        case str === 'l':
          return finish({ action: 'lyric', index: f.cursor });
        case str === 'd':
          return finish({ action: 'download', index: f.cursor });
        case str === 'p':
          return finish({ action: 'preview', index: f.cursor });
        case str === 's':
          return finish({ action: 'stop' });
        case str === 'D':
          return finish({ action: 'downloadAll' });
        case str === '/':
          return finish({ action: 'search' });
        case str === 'b' || name === 'escape':
          return finish({ action: 'back' });
        case str === 'q':
          return finish({ action: 'quit' });
        default:
          return;
      }
    };
    stdin.on('keypress', onKey);
  });
}

async function browseLine(f, ask) {
  const total = clampPage(f);
  process.stdout.write(`\n${topLine(f, total)}\n`);
  for (const line of renderRows(f)) process.stdout.write(line + '\n');
  if (!f.rows.length) process.stdout.write(c.gray('  没有结果\n'));
  process.stdout.write(
    c.gray('  [序号] 打开 · p/u/l/d <序号> · s 停止预览 · D 全部下载 · n/p 翻页 · b 返回 · / 搜索 · q 退出\n'),
  );
  const ans = await ask('  > ');
  if (ans === null) return { action: 'quit' };
  const raw = String(ans).trim();
  const lower = raw.toLowerCase();
  if (!lower) return { action: 'none' };
  if (lower === 'q' || lower === 'quit') return { action: 'quit' };
  if (lower === 'b' || lower === 'back') return { action: 'back' };
  if (lower === '/') return { action: 'search' };
  if (lower === 's') return { action: 'stop' };
  if (lower === 'n') {
    f.page = Math.min(total - 1, f.page + 1);
    return { action: 'none' };
  }
  if (lower === 'p') {
    f.page = Math.max(0, f.page - 1);
    return { action: 'none' };
  }
  if (lower === 'd' || lower === 'D') return { action: 'downloadAll' };
  if (lower.startsWith('/')) return { action: 'slash', text: raw };
  const m = raw.match(/^([puldn])\s+(\d+)$/i);
  if (m) {
    const index = Number(m[2]) - 1;
    if (!f.rows[index]) return { action: 'none' };
    return { action: { p: 'preview', u: 'url', l: 'lyric', d: 'download', n: 'open' }[m[1].toLowerCase()], index };
  }
  if (/^\d+$/.test(raw)) {
    const index = Number(raw) - 1;
    if (f.rows[index]) return { action: 'open', index };
  }
  return { action: 'search', keywords: raw };
}

async function downloadAll(f, ask) {
  const songs = f.rows.filter((r) => r.kind === 'song');
  if (!songs.length) {
    process.stdout.write(c.yellow('当前列表没有可下载的歌曲\n'));
    return;
  }
  const level = await chooseDownloadLevel(ask, downloadLevel);
  if (!level) return;
  downloadLevel = level;
  process.stdout.write(c.gray(`准备下载 ${songs.length} 首到 ./downloads\n`));
  let ok = 0;
  for (const s of songs) if (await downloadSong(s.id, './downloads', level)) ok++;
  process.stdout.write(`完成: ${c.green(ok + ' 成功')} / ${songs.length}\n`);
}

async function run() {
  banner();
  const rl = isTTY ? null : readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const qa = isTTY ? { ask: askLineTTY, isClosed: () => false } : makeQuestion(rl);
  const question = qa.ask;
  const guard = (fn) => fn();
  const prompt = isTTY ? `${c.cyan('♫')} ${c.gray('搜索/命令')} > ` : 'nj> ';
  let type = 'song';
  const stack = [];

  const slash = async (text) => {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') return 'quit';
    if (cmd === 'stop') {
      stopPreview();
      process.stdout.write(c.gray('已停止预览。\n'));
      return;
    }
    if (cmd === 'help') {
      helpText();
      return;
    }
    if (cmd === 'login') {
      try {
        await require('./cli').main(['login']);
      } catch (err) {
        process.stdout.write(c.red(`登录失败: ${err.message}\n`));
      }
      banner();
      return;
    }
    if (cmd === 'whoami' || cmd === 'status' || cmd === 'account') {
      const st = await login.accountState().catch(() => null);
      if (!st?.loggedIn) {
        process.stdout.write(c.yellow('未登录或登录态已失效，输入 /login 登录\n'));
      } else {
        process.stdout.write(
          `${c.bold(st.profile.nickname)}  ${c.gray('uid ' + st.profile.userId)}  ` +
            (st.profile.vip ? c.yellow(st.profile.vipLabel) : c.gray('非会员（VIP 歌曲不可用）')) +
            '\n',
        );
      }
      return;
    }
    if (cmd === 'logout') {
      require('./request').clearLoginCookie();
      process.stdout.write(c.green('已清除本地登录态\n'));
      banner();
      return;
    }
    if (cmd === 'level') {
      const lv = String(arg || '').trim();
      if (!lv) {
        const picked = await chooseDownloadLevel(question, downloadLevel);
        if (picked) downloadLevel = picked;
      } else if (LEVELS.includes(lv)) {
        downloadLevel = lv;
        process.stdout.write(c.gray(`下载音质: ${lv}（取不到会自动降级）\n`));
      } else {
        process.stdout.write(c.yellow('用法: /level standard|higher|exhigh|lossless\n'));
      }
      return;
    }
    if (cmd === 'type') {
      if (['song', 'album', 'artist', 'playlist'].includes(arg)) {
        type = arg;
        stack.length = 0;
        process.stdout.write(c.gray(`搜索类型: ${type}（已回到搜索）\n`));
      } else process.stdout.write(c.yellow('类型只能是 song/album/artist/playlist\n'));
      return;
    }
    if (cmd === 'page') {
      const f = stack[stack.length - 1];
      if (!f) process.stdout.write(c.yellow('当前没有列表\n'));
      else {
        const n = Number(arg);
        if (!n || n < 1) process.stdout.write(c.yellow('用法: /page 2\n'));
        else {
          f.page = n - 1;
          clampPage(f);
        }
      }
      return;
    }
    process.stdout.write(c.yellow(`未知命令 /${cmd}，输入 /help 查看\n`));
  };

  try {
    for (;;) {
      if (!stack.length) {
        const line = await question(prompt);
        if (line === null) break;
        const text = line.trim();
        if (!text) continue;
        if (text.startsWith('/')) {
          if ((await slash(text)) === 'quit') break;
          continue;
        }
        if (/^\d{3,}$/.test(text) || /https?:\/\/|163cn\.tv/.test(text)) {
          const { parseTarget } = require('./parse');
          const parsed = await parseTarget(text);
          if (!parsed) {
            process.stdout.write(c.yellow('链接解析失败\n'));
            continue;
          }
          const detail = await api.songDetail([parsed.id]).catch(() => null);
          if (parsed.type === 'song' && detail?.songs?.[0]) {
            await guard(() => detailView(withPrivileges(detail.songs, detail.privileges)[0], question));
          } else {
            process.stdout.write(c.gray(`解析到 ${parsed.type} ${parsed.id}\n`));
          }
          continue;
        }

        process.stdout.write(c.gray('搜索中…'));
        try {
          const f = await doSearch(text, type);
          process.stdout.write('\r\x1b[2K');
          stack.push(f);
        } catch (err) {
          process.stdout.write('\r\x1b[2K' + c.red(`搜索失败: ${err.message}`) + '\n');
        }
        continue;
      }

      const f = stack[stack.length - 1];
      let res;
      try {
        res = isTTY ? await guard(() => browseRaw(f)) : await browseLine(f, question);
      } catch (err) {
        process.stdout.write(c.red(`出错: ${err.message}\n`));
        stack.pop();
        continue;
      }
      if (res.action === 'fallback') continue;

      if (res.action === 'quit') break;
      if (res.action === 'stop') {
        stopPreview();
        process.stdout.write(c.gray('已停止预览。\n'));
        continue;
      }
      if (res.action === 'slash') {
        if ((await slash(res.text)) === 'quit') break;
        continue;
      }
      if (res.action === 'back') {
        stack.pop();
        continue;
      }
      if (res.action === 'search') {
        stack.length = 0;
        if (res.keywords) {
          try {
            stack.push(await doSearch(res.keywords, type));
          } catch (err) {
            process.stdout.write(c.red(`搜索失败: ${err.message}\n`));
          }
        }
        continue;
      }
      if (res.action === 'downloadAll') {
        await downloadAll(f, question);
        continue;
      }

      const target = f.rows[res.index];
      if (!target) continue;

      if (res.action === 'open') {
        if (target.kind === 'song') {
          const detail = await api.songDetail([target.id]);
          const song = withPrivileges(detail.songs, detail.privileges)[0];
          if (song) await guard(() => detailView(song, question));
        } else {
          try {
            await drill(target, stack);
          } catch (err) {
            process.stdout.write(c.red(`加载失败: ${err.message}\n`));
          }
        }
        continue;
      }
      if (target.kind !== 'song') {
        process.stdout.write(c.yellow('请先打开列表，再选择一首歌曲。\n'));
        continue;
      }
      try {
        if (res.action === 'preview') await previewSong(target.id);
        else if (res.action === 'url') await showUrl(target.id);
        else if (res.action === 'lyric') await showLyric(target.id);
        else if (res.action === 'download') {
          const level = await chooseDownloadLevel(question, downloadLevel);
          if (level) { downloadLevel = level; await downloadSong(target.id, './downloads', level); }
        }
      } catch (err) { process.stdout.write(c.red(`操作失败: ${err.message}\n`)); }
    }
  } finally {
    if (rl) rl.close();
    stopPreview();
  }
  process.stdout.write(c.gray('\n再见 ♪\n'));
}

module.exports = { run };
