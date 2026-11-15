const path = require('path');
const readline = require('readline');
const api = require('./api');
const login = require('./login');
const { c, table, duration, size, joinNames } = require('./format');
const { downloadTo, resolvePath, extFromUrl } = require('./download');
const { parseTarget, songId } = require('./parse');
const { loadConfig, saveConfig, CONFIG_PATH } = require('./config');
const { LEVELS, LEVEL_LABEL, withPrivileges, songBadge, songTitle, trialLabel, playbackLabel, chooseDownloadLevel } = require('./music');
const { previewSong } = require('./preview');

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split('=');
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else if (/^-[a-zA-Z]/.test(arg) && arg.length > 1 && !/^-\d/.test(arg)) {
      const key = arg[1];
      const rest = arg.slice(2);
      if (rest) out.flags[key] = rest;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

const flag = (o, long, short) => o.flags[long] ?? (short ? o.flags[short] : undefined);

function out(text) {
  process.stdout.write(text + '\n');
}

function json(obj) {
  out(JSON.stringify(obj, null, 2));
}

/** 非 TTY（管道 / 重定向）时把整段 stdin 读成行队列，避免多次建 readline 丢行 */
let pipedQueue = null;
function readStdinLines() {
  const fs = require('fs');
  const chunks = [];
  const buf = Buffer.alloc(65536);
  try {
    for (;;) {
      const n = fs.readSync(0, buf, 0, buf.length, null);
      if (!n) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch {}
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
}

/** 行内提问；hidden=true 时用于密码输入（不回显） */
function askLine(promptText, { hidden = false } = {}) {
  if (!process.stdin.isTTY) {
    if (pipedQueue === null) pipedQueue = readStdinLines();
    process.stdout.write(promptText);
    const line = pipedQueue.shift();
    if (line === undefined) return Promise.resolve(null);
    if (!hidden) process.stdout.write(line + '\n');
    return Promise.resolve(line);
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try {
        rl.close();
      } catch {}
      resolve(v);
    };
    if (hidden) {
      rl._writeToOutput = () => {};
      process.stdout.write(promptText);
    }
    rl.question(promptText, (ans) => finish(ans));
    rl.on('close', () => finish(null));
  });
}

function wan(n) {
  if (!n) return '0';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
  return String(n);
}

function songRows(songs, startIndex = 1) {
  return songs.map((s, i) => ({
    n: String(startIndex + i),
    name: songTitle(s),
    artist: joinNames(s.ar || s.artists),
    album: (s.al || s.album || {}).name || '',
    time: duration(s.dt || s.duration),
    id: String(s.id),
  }));
}

const SONG_COLUMNS = [
  { title: '#', key: 'n', align: 'right', max: 4 },
  { title: '歌曲', key: 'name', max: 68, color: c.bold },
  { title: '歌手', key: 'artist', max: 18 },
  { title: '专辑', key: 'album', max: 22 },
  { title: '时长', key: 'time', align: 'right', max: 6 },
  { title: 'ID', key: 'id', max: 12, color: c.gray },
];

function printSongs(songs, startIndex = 1, hint = true) {
  if (!songs.length) {
    out(c.yellow('没有结果'));
    return;
  }
  out(table(SONG_COLUMNS, songRows(songs, startIndex)));
  if (hint) out(c.gray(`\n  nj preview <ID>  预览   nj url <ID>  取直链   nj lyric <ID>  看歌词   nj download <ID>  下载`));
}

async function cmdSearch(o) {
  const kw = o._.join(' ');
  if (!kw) throw new Error('用法: nj search <关键词> [--type song|album|artist|playlist] [--limit 20]');
  const type = flag(o, 'type', 't') || 'song';
  const limit = Number(flag(o, 'limit', 'n') || 20);
  const offset = Number(flag(o, 'offset') || 0);
  const res = await api.search(kw, { type, limit, offset });
  if (flag(o, 'json')) return json(res);

  const result = res.result || {};
  const total = result.songCount ?? result.albumCount ?? result.artistCount ?? result.playlistCount ?? 0;
  out(c.gray(`关键词: ${kw}   类型: ${type}   共 ${total} 条   显示 ${offset + 1}-${offset + (result.songs || result.albums || result.artists || result.playlists || []).length}`));

  if (result.songs) {
    printSongs(withPrivileges(result.songs, result.privileges));
  } else if (result.albums) {
    out(
      table(
        [
          { title: '#', key: 'n', align: 'right', max: 4 },
          { title: '专辑', key: 'name', max: 34, color: c.bold },
          { title: '歌手', key: 'artist', max: 18 },
          { title: '歌曲数', key: 'count', align: 'right', max: 6 },
          { title: 'ID', key: 'id', max: 12, color: c.gray },
        ],
        result.albums.map((a, i) => ({
          n: String(offset + i + 1),
          name: a.name,
          artist: joinNames(a.artists),
          count: a.size ?? '-',
          id: String(a.id),
        })),
      ).replace(/\n/g, '\n') + c.gray('\n\n  nj album <ID>  查看专辑'),
    );
  } else if (result.artists) {
    out(
      table(
        [
          { title: '#', key: 'n', align: 'right', max: 4 },
          { title: '歌手', key: 'name', max: 28, color: c.bold },
          { title: '别名', key: 'alias', max: 22 },
          { title: '专辑数', key: 'albums', align: 'right', max: 6 },
          { title: 'ID', key: 'id', max: 12, color: c.gray },
        ],
        result.artists.map((a, i) => ({
          n: String(offset + i + 1),
          name: a.name,
          alias: (a.alias || []).join('/') || '-',
          albums: a.albumSize ?? '-',
          id: String(a.id),
        })),
      ) + c.gray('\n\n  nj artist <ID>  查看歌手'),
    );
  } else if (result.playlists) {
    out(
      table(
        [
          { title: '#', key: 'n', align: 'right', max: 4 },
          { title: '歌单', key: 'name', max: 34, color: c.bold },
          { title: '创建者', key: 'creator', max: 14 },
          { title: '歌曲数', key: 'count', align: 'right', max: 6 },
          { title: '播放', key: 'plays', align: 'right', max: 8 },
          { title: 'ID', key: 'id', max: 12, color: c.gray },
        ],
        result.playlists.map((p, i) => ({
          n: String(offset + i + 1),
          name: p.name,
          creator: (p.creator || {}).nickname || '-',
          count: p.trackCount ?? '-',
          plays: wan(p.playCount),
          id: String(p.id),
        })),
      ) + c.gray('\n\n  nj playlist <ID>  查看歌单'),
    );
  } else {
    json(res);
  }
}

async function cmdSong(o) {
  const raw = o._.join(' ');
  if (!raw) throw new Error('用法: nj song <ID...|歌曲链接|分享文本>');
  const inputs = /^[\d,\s]+$/.test(raw) ? raw.split(/[,\s]+/).filter(Boolean) : [raw];
  const ids = await Promise.all(inputs.map(songId));
  const res = await api.songDetail(ids);
  if (flag(o, 'json')) return json(res);
  const songs = withPrivileges(res.songs, res.privileges);
  for (const s of songs) {
    out('');
    out(`${c.bold(songTitle(s))}  ${c.gray('#' + s.id)}`);
    out(`  ${c.gray('歌手')}  ${joinNames(s.ar)}`);
    out(`  ${c.gray('专辑')}  ${s.al?.name || '-'}${s.al?.publishTime ? c.gray(` (${new Date(s.al.publishTime).toISOString().slice(0, 10)})`) : ''}`);
    out(`  ${c.gray('时长')}  ${duration(s.dt)}`);
    out(`  ${c.gray('链接')}  ${c.blue(`https://music.163.com/song?id=${s.id}`)}`);
  }
}

async function cmdUrl(o) {
  const raw = o._.join(' ');
  if (!raw) throw new Error('用法: nj url <ID|歌曲链接|分享文本> [--level standard|higher|exhigh|lossless]');
  const id = await songId(raw);
  const level = flag(o, 'level', 'l') || 'lossless';
  if (!LEVELS.includes(level)) throw new Error(`level 只能是 ${LEVELS.join('/')}`);

  const [detail, urls] = await Promise.all([api.songDetail([id]).catch(() => null), api.songUrl(id, level)]);
  if (flag(o, 'json')) return json(urls);

  const track = urls.data?.[0] || {};
  const song = withPrivileges(detail?.songs, detail?.privileges)[0];
  if (song) out(`${c.bold(songTitle(song))}  ${c.gray('—')}  ${joinNames(song.ar)}`);
  const { isLoggedIn } = require('./request');
  if (!track.url) {
    out(c.yellow('没有可用播放地址。'));
    if (!isLoggedIn()) {
      out(c.gray('  当前未登录。VIP/付费歌曲必须先登录黑胶账号：'));
      out(c.gray('    nj login            扫码 / 手机号 / 短信码，任选一种'));
      out(c.gray('    nj login --cookie "MUSIC_U=...; __csrf=..."'));
    } else {
      const acc = await login.accountState().catch(() => null);
      if (acc?.profile && !acc.profile.vip) {
        out(c.yellow(`  已登录「${acc.profile.nickname}」，但账号不是黑胶会员，拿不到 VIP 曲目地址。`));
      } else {
        out(c.gray('  已登录，但这首歌仍然受限（版权下架 / 单曲付费 / 地区限制）。'));
      }
    }
    return;
  }
  out(`  ${c.gray('音质')}  ${LEVEL_LABEL[track.level] || track.level}  ${c.gray('·')}  ${track.type?.toUpperCase()}  ${c.gray('·')}  ${Math.round((track.br || 0) / 1000)}kbps  ${c.gray('·')}  ${size(track.size)}`);
  if (track._source) out(c.gray(`  ${c.gray('来源')}  ${track._source}${track._downgradedFrom ? ` · 已从 ${LEVEL_LABEL[track._downgradedFrom] || track._downgradedFrom} 降级` : ''}`));
  if (trialLabel(track)) out(c.yellow(`  ⚠ ${trialLabel(track)}（接口实际返回的片段）`));
  out(`  ${c.gray('链接')}  ${c.cyan(track.url)}`);
  if (track.md5) out(`  ${c.gray('MD5')}   ${track.md5}`);
  const ext = extFromUrl(track.url, track.type);
  out(c.gray(`\n  nj download ${id}  直接下载 .${ext}`));
}

async function cmdPreview(o) {
  const raw = o._.join(' ');
  if (!raw) throw new Error('用法: nj preview <歌曲ID|链接|分享文本> [--level standard]');
  const id = await songId(raw);
  const level = flag(o, 'level', 'l') || 'standard';
  if (!LEVELS.includes(level)) throw new Error(`level 只能是 ${LEVELS.join('/')}`);
  if (flag(o, 'json')) return cmdUrl({ _: [id], flags: { ...o.flags, level } });
  return previewSong(id, level);
}

function mergeLyric(lrc, tlrc) {
  if (!lrc) return tlrc || '';
  if (!tlrc) return lrc;
  const trans = new Map();
  for (const line of tlrc.split('\n')) {
    const m = line.match(/^\[(\d+:\d+(?:\.\d+)?)\](.*)$/);
    if (m && m[2].trim()) trans.set(m[1], m[2].trim());
  }
  return lrc
    .split('\n')
    .map((line) => {
      const m = line.match(/^\[(\d+:\d+(?:\.\d+)?)\](.*)$/);
      if (m && trans.has(m[1])) {
        const t = trans.get(m[1]);
        return `${line}\n${c.gray(`[${m[1]}]${t}`)}`;
      }
      return line;
    })
    .join('\n');
}

async function cmdLyric(o) {
  const raw = o._.join(' ');
  if (!raw) throw new Error('用法: nj lyric <ID|歌曲链接|分享文本> [--trans]');
  const id = await songId(raw);
  const res = await api.lyric(id);
  if (flag(o, 'json')) return json(res);
  const trans = flag(o, 'trans', 't');
  const text = mergeLyric(res.lrc?.lyric || '', trans ? res.tlyric?.lyric || '' : '');
  if (!text.trim()) {
    out(c.yellow('这首歌没有歌词（纯音乐或未收录）。'));
    return;
  }
  out(text);
}

async function cmdPlaylist(o) {
  const id = o._[0];
  if (!id) throw new Error('用法: nj playlist <ID> [--all]');
  const res = await api.playlistDetail(id);
  if (flag(o, 'json')) return json(res);
  const pl = res.playlist;
  if (!pl) throw new Error('歌单不存在');
  const limit = flag(o, 'all') ? pl.tracks.length : Math.min(Number(flag(o, 'limit', 'n') || 50), 500);
  out('');
  out(`${c.bold(pl.name)}  ${c.gray('#' + pl.id)}`);
  out(`  ${c.gray('创建者')}  ${pl.creator?.nickname || '-'}   ${c.gray('歌曲')} ${pl.trackCount}   ${c.gray('播放')} ${wan(pl.playCount)}   ${c.gray('收藏')} ${wan(pl.subscribedCount)}`);
  if (pl.description) out(c.gray('  ' + pl.description.replace(/\n/g, ' ').slice(0, 120)));
  out('');
  printSongs(withPrivileges(pl.tracks.slice(0, limit), res.privileges || pl.privileges), 1, false);
  if (pl.tracks.length > limit) {
    out(c.gray(`\n  还有 ${pl.tracks.length - limit} 首未显示，加 --all 或 --limit 500`));
  }
  out(c.gray('\n  nj download ' + pl.tracks.slice(0, 3).map((t) => t.id).join(',') + '  批量下载前 3 首'));
}

async function cmdAlbum(o) {
  const id = o._[0];
  if (!id) throw new Error('用法: nj album <ID>');
  const res = await api.album(id);
  if (flag(o, 'json')) return json(res);
  const al = res.album;
  if (!al) throw new Error('专辑不存在');
  out('');
  out(`${c.bold(al.name)}  ${c.gray('#' + al.id)}`);
  out(`  ${c.gray('歌手')}  ${joinNames(al.artists)}   ${c.gray('发行')} ${al.publishTime ? new Date(al.publishTime).toISOString().slice(0, 10) : '-'}   ${c.gray('歌曲')} ${al.size}`);
  if (al.description) out(c.gray('  ' + al.description.replace(/\n/g, ' ').slice(0, 120)));
  out('');
  const songs = (al.songs && al.songs.length ? al.songs : res.songs) || [];
  printSongs(withPrivileges(songs, res.privileges), 1, false);
}

async function cmdArtist(o) {
  const id = o._[0];
  if (!id) throw new Error('用法: nj artist <ID> [--songs]');
  const res = await api.artist(id);
  if (flag(o, 'json')) return json(res);
  out('');
  out(`${c.bold(res.artist?.name || '未知')}  ${c.gray('#' + res.artist?.id)}`);
  out(`  ${c.gray('别名')}  ${(res.artist?.alias || []).join('/') || '-'}   ${c.gray('专辑')} ${res.artist?.albumSize ?? '-'}   ${c.gray('MV')} ${res.artist?.mvSize ?? '-'}`);
  if (res.artist?.briefDesc) out(c.gray('  ' + res.artist.briefDesc.slice(0, 120)));

  const hot = res.hotSongs || [];
  if (hot.length) {
    out(c.gray('\n  热门 50 首：'));
    printSongs(withPrivileges(hot, res.privileges), 1, false);
  }
  if (flag(o, 'songs')) {
    const songs = await api.artistSongs(id, Number(flag(o, 'limit', 'n') || 50));
    out(c.gray('\n  全部歌曲：'));
    printSongs(withPrivileges(songs.songs, songs.privileges), 1, false);
  }
}

async function cmdDownload(o) {
  const raw = o._.join(' ');
  const playlistId = flag(o, 'playlist', 'p');
  if (!raw && !playlistId) {
    throw new Error('用法: nj download <ID|链接|分享文本> [-o 目录] [--level lossless] [--playlist <歌单ID>]');
  }
  let level = flag(o, 'level', 'l');
  if (level && !LEVELS.includes(level)) throw new Error(`level 只能是 ${LEVELS.join('/')}`);
  if (!level && process.stdin.isTTY && process.stdout.isTTY) {
    level = await chooseDownloadLevel(askLine);
    if (!level) return out(c.gray('已取消下载。'));
  }
  level = level || 'lossless';
  const dir = flag(o, 'o', 'd') || './downloads';

  const ids = [];
  if (raw) {
    const whole = /https?:\/\/|163cn\.tv/.test(raw) ? await parseTarget(raw) : null;
    if (whole && whole.type !== 'song') throw new Error('请使用歌曲链接；下载歌单请用 --playlist <歌单ID>。');
    if (whole && /https?:\/\/\S+/.test(raw) && !/[,\s]{1,}\S*https?:\/\//.test(raw)) {
      ids.push(whole.id);
    } else {
      for (const t of raw.split(/[,\s]+/).filter(Boolean)) {
        if (/^\d{3,}$/.test(t)) {
          ids.push(t);
          continue;
        }
        const parsed = await parseTarget(t);
        if (parsed?.type === 'song') ids.push(parsed.id);
        else out(c.yellow(`跳过无法识别的目标: ${t}`));
      }
    }
  }

  if (playlistId) {
    const res = await api.playlistDetail(playlistId, 1000);
    const tracks = res.playlist?.tracks || [];
    out(c.gray(`歌单「${res.playlist?.name}」共 ${tracks.length} 首`));
    for (const t of tracks) ids.push(String(t.id));
  }

  const unique = [...new Set(ids)];
  if (!unique.length) throw new Error('没有解析出歌曲 ID');
  const cap = Number(flag(o, 'limit', 'n') || 0);
  const queue = cap > 0 ? unique.slice(0, cap) : unique;

  const { isLoggedIn } = require('./request');
  const loggedIn = isLoggedIn();
  if (!loggedIn) out(c.yellow('提示: 当前未登录，VIP 歌曲只能下载接口提供的试听片段（通常 30 秒），没有试听地址时会跳过。'));

  out(c.gray(`准备下载 ${queue.length} 首 · 音质 ${LEVEL_LABEL[level] || level} · 目录 ${path.resolve(dir)}`));
  let ok = 0;
  let fail = 0;
  let vipSkip = 0;

  for (const id of queue) {
    try {
      const [detail, urls] = await Promise.all([api.songDetail([id]).catch(() => ({ songs: [] })), api.songUrl(id, level)]);
      const song = withPrivileges(detail.songs, detail.privileges)[0];
      const track = urls.data?.[0];
      const label = song ? `${song.name} - ${joinNames(song.ar)}` : id;

      if (!track?.url) {
        if (track?.freeTrialInfo) {
          out(c.yellow(`✗ ${label}  只有试听片段（VIP 曲目）`));
        } else {
          out(c.yellow(`✗ ${label}  无可用地址（VIP/付费/版权）`));
        }
        vipSkip++;
        fail++;
        continue;
      }

      if (songBadge(song)) out(c.yellow(`${songBadge(song)} ${label}`));
      const trial = trialLabel(track);
      if (trial) out(c.yellow(`⚠ 当前仅能下载${trial}，不会保存为完整版。`));
      const ext = extFromUrl(track.url, track.type);
      const nameTemplate = flag(o, 'name');
      const baseName = nameTemplate
        ? nameTemplate
            .replace('{name}', song?.name || id)
            .replace('{artist}', joinNames(song?.ar))
            .replace('{album}', song?.al?.name || '')
            .replace('{id}', id)
        : `${joinNames(song?.ar) || 'unknown'} - ${song?.name || id}`;

      const filePath = resolvePath(dir, baseName + (trial ? ` (${trial})` : ''), ext);
      process.stdout.write(`${c.cyan('↓')} ${path.basename(filePath)}  `);
      const { bytes } = await downloadTo(track.url, filePath);
      out(c.green(`✓ ${size(bytes)} · ${playbackLabel(track) || LEVEL_LABEL[level]}`));
      ok++;
    } catch (err) {
      out(c.red(`✗ ${id}  ${err.message}`));
      fail++;
    }
  }
  out('');
  out(`完成: ${c.green(ok + ' 成功')}${fail ? '  ' + c.red(fail + ' 失败') : ''}`);
  if (vipSkip) {
    out(
      c.gray(
        `  ${vipSkip} 首因会员权限/版权没有地址` +
          (loggedIn ? '（当前账号可能不是黑胶会员，nj whoami 可确认）' : '，登录黑胶账号后重试：nj login'),
      ),
    );
  }
}

async function cmdParse(o) {
  const raw = o._.join(' ');
  if (!raw) throw new Error('用法: nj parse <链接|分享文本>');
  const parsed = await parseTarget(raw);
  if (!parsed) throw new Error('没能从这段内容里解析出 ID');
  if (flag(o, 'json')) return json(parsed);
  out(`  ${c.gray('类型')}  ${parsed.type}`);
  out(`  ${c.gray('ID')}    ${parsed.id}`);
  out(`  ${c.gray('来源')}  ${parsed.source}`);

  if (parsed.type === 'song') return cmdSong({ _: [parsed.id], flags: o.flags });
  if (parsed.type === 'playlist') return cmdPlaylist({ _: [parsed.id], flags: o.flags });
  if (parsed.type === 'album') return cmdAlbum({ _: [parsed.id], flags: o.flags });
  if (parsed.type === 'artist') return cmdArtist({ _: [parsed.id], flags: o.flags });
}

async function cmdToplist(o) {
  const res = await api.toplist();
  if (flag(o, 'json')) return json(res);
  const list = res.list || [];
  out(
    table(
      [
        { title: '榜单', key: 'name', max: 26, color: c.bold },
        { title: '更新频率', key: 'freq', max: 10 },
        { title: 'ID', key: 'id', max: 14, color: c.gray },
      ],
      list.map((t) => ({ name: t.name, freq: t.updateFrequency || '-', id: String(t.id) })),
    ) + c.gray('\n\n  nj playlist <ID>  查看榜单歌曲'),
  );
}

function renderQr(content) {
  try {
    const qrcode = require('qrcode-terminal');
    let art = '';
    qrcode.generate(content, { small: true }, (text) => (art += text));
    if (!art) return false;
    out(art);
    return true;
  } catch {
    return false;
  }
}

function printProfile(profile, vip) {
  out(`${c.bold(profile.nickname || '未知昵称')}  ${c.gray('uid ' + (profile.userId || '-'))}`);
  const vipline = profile.vip ? c.yellow(profile.vipLabel) : c.gray(profile.vipLabel || '普通用户');
  const level = vip?.redVipLevel ? c.gray(` · 黑胶等级 ${vip.redVipLevel}`) : '';
  out(`  ${c.gray('VIP')}   ${vipline}${level}`);
  if (vip?.expireAt) out(`  ${c.gray('到期')}  ${new Date(vip.expireAt).toISOString().slice(0, 10)}`);
  if (!profile.vip) out(c.gray('  普通账号只能下免费曲目；VIP 歌曲需要黑胶会员账号。'));
}

async function afterLogin() {
  out(c.gray('\n正在校验登录态…'));
  const acc = await login.fetchAccount().catch((err) => {
    out(c.yellow(`账号校验失败: ${err.message}`));
    if (err.risk) {
      out(c.gray('  cookie 已保存，风控解除后 `nj whoami` 会自动重新校验。'));
    } else {
      out(c.gray('  建议重新登录：nj login（扫码 / 手机号），或确认 MUSIC_U 复制完整。'));
    }
    return null;
  });
  if (!acc) {
    out(c.gray(`配置: ${CONFIG_PATH}`));
    return null;
  }
  const vip = await login.vipInfo().catch(() => null);
  out('');
  out(c.green('登录成功'));
  printProfile(acc.summary, vip);
  out(c.gray(`\nCookie 已保存到 ${CONFIG_PATH}`));
  out(c.gray('现在可以: nj download <ID> --level lossless'));
  return acc;
}

async function loginInteractive() {
  out(`
${c.bold('选择登录方式')}
  1  从浏览器直接复用登录态（浏览器里已登录网易云时最快）
  2  扫码登录（手机网易云 App 扫终端二维码）
  3  手机号 + 短信验证码
  4  手机号 + 密码
  5  粘贴浏览器 Cookie
`);
  const ans = (await askLine('  > ')) || '';
  const choice = ans.trim();
  if (choice === '1') {
    const { readBrowserCookie } = require('./browsercookie');
    const found = readBrowserCookie({ browser: 'auto' });
    out(c.gray(`  取自 ${found.browser}/${found.profile}`));
    await login.loginByCookie(found.cookie);
    return afterLogin();
  }
  if (choice === '2' || choice === '3' || choice === '4') {
    if (choice === '2') return doQrLogin();
    const phone = (await askLine('  手机号: ')) || '';
    if (choice === '4') {
      const pwd = (await askLine('  密码（不回显，回车确认）: ', { hidden: true })) || '';
      await login.loginByPhonePassword(phone.trim(), pwd.trim());
    } else {
      const sent = await login.sendSmsCaptcha(phone.trim());
      out(c.gray(`  验证码已发送（code=${sent.code}）`));
      const code = (await askLine('  短信验证码: ')) || '';
      await login.loginByPhoneCaptcha(phone.trim(), code.trim());
    }
    return afterLogin();
  }
  if (choice === '5') {
    out(c.gray('    Network → F5 刷新 → 点任一 music.163.com 请求 → Headers → Request Headers'));
    out(c.gray('       → cookie: 那一行全选复制）'));
    const cookie = (await askLine('  粘贴到这里: ')) || '';
    await login.loginByCookie(cookie);
    return afterLogin();
  }
  out(c.yellow('没有选择，已取消。'));
  return 'cancel';
}

async function doQrLogin() {
  out(c.gray('\n用手机「网易云音乐」App → 左上角菜单 → 扫一扫'));
  await login.qrLogin({
    onRender: (content) => {
      if (!renderQr(content)) {
        out(c.yellow('  未安装二维码渲染依赖（可选）: npm i qrcode-terminal'));
        out(c.gray('  也可以把下面这行自己转成二维码扫：'));
        out(`  ${content}`);
      }
      out(c.gray('  等待扫码…（Ctrl+C 取消）'));
    },
    onStatus: (msg) => out(c.gray(`  ${msg}`)),
  });
  return afterLogin();
}

async function cmdLogin(o) {
  const cookie = flag(o, 'cookie', 'c');
  const cookieFile = flag(o, 'cookie-file');
  const browser = flag(o, 'browser', 'b');
  const phone = flag(o, 'phone', 'p');
  const password = flag(o, 'password', 'w');
  const captcha = flag(o, 'captcha');
  const email = flag(o, 'email');
  const cc = String(flag(o, 'cc') || '86');
  const send = flag(o, 'send');
  const qr = flag(o, 'qr');

  if (browser) {
    const { readBrowserCookie } = require('./browsercookie');
    const name = browser === true ? 'auto' : String(browser);
    const closeFirst = flag(o, 'close-browser') || flag(o, 'kill');
    if (closeFirst) {
      const targets = name === 'auto' ? ['chrome', 'msedge'] : [name === 'edge' ? 'msedge' : name];
      for (const img of targets) {
        out(c.gray(`  关闭 ${img}（未保存的网页会丢）…`));
        try {
          require('child_process').execFileSync('taskkill', ['/IM', `${img}.exe`, '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    out(c.gray(`正在从本机浏览器（${name}）读取 music.163.com 的登录 Cookie…`));
    const found = readBrowserCookie({ browser: name, profileName: flag(o, 'profile') });
    out(c.gray(`取自 ${found.browser}/${found.profile}，共 ${found.names.length} 个 cookie`));
    await login.loginByCookie(found.cookie);
    return afterLogin();
  }
  if (cookie || cookieFile) {
    const raw = cookieFile ? require('fs').readFileSync(cookieFile, 'utf8') : cookie;
    await login.loginByCookie(raw);
    return afterLogin();
  }
  if (qr) return doQrLogin();
  if (email) {
    if (!password) throw new Error('邮箱登录需要 --password');
    await login.loginByEmail(email, password);
    return afterLogin();
  }
  if (phone) {
    if (send) {
      const res = await login.sendSmsCaptcha(phone, { ctcode: cc });
      out(c.green(`验证码已发送（code=${res.code}）`));
      out(c.gray(`下一步: nj login --phone ${phone} --captcha <收到的验证码>`));
      return;
    }
    if (captcha) {
      await login.loginByPhoneCaptcha(phone, captcha, { countrycode: cc });
      return afterLogin();
    }
    if (password) {
      await login.loginByPhonePassword(phone, password, { countrycode: cc });
      return afterLogin();
    }
    out(c.yellow('手机号登录还需要 --password 或 --captcha，或者先 --send 发验证码。'));
    return;
  }

  const picked = await loginInteractive();
  if (picked !== 'cancel') return picked;

  throw new Error(
    '用法:\n' +
      '  nj login                              交互式选择登录方式\n' +
      '  nj login --browser chrome|edge|firefox|auto   复用浏览器登录态（最快）\n' +
      '  nj login --browser chrome --close-browser     先关闭浏览器再读（Cookie 库被独占时）\n' +
      '  nj login --qr                         扫码登录（手机网易云 App）\n' +
      '  nj login --phone 13800138000 --password 你的密码\n' +
      '  nj login --phone 13800138000 --send   先发短信验证码\n' +
      '  nj login --phone 13800138000 --captcha 1234\n' +
      '  nj login --email you@mail.com --password 你的密码\n' +
      '  nj login --cookie "MUSIC_U=xxx; __csrf=yyy"\n' +
      '  nj login --cookie-file cookie.txt\n' +
      '  --cc 86  指定国家码（默认 86）',
  );
}

async function cmdWhoami(o) {
  const state = await login.accountState();
  if (flag(o, 'json')) return json(state);
  if (!state.cookie) {
    out(c.yellow('尚未登录。执行 nj login（扫码/手机号）或 nj login --cookie "MUSIC_U=..."'));
    return;
  }
  if (!state.loggedIn) {
    if (state.risk) {
      out(c.yellow('账号校验被网易风控拦截（-462/-460），Cookie 已存但暂时验证不了。'));
      out(c.gray('  等几分钟或换网络后重新 nj whoami；急着下载可以直接 nj download 试。'));
    } else {
      out(c.yellow('本地有 Cookie，但服务端不认（已过期或被顶下线）。重新 nj login 即可。'));
    }
    out(c.gray(`配置: ${CONFIG_PATH}`));
    return;
  }
  printProfile(state.profile, state.vip);
  out(`  ${c.gray('CSRF')}  ${state.csrf ? '已带 __csrf' : c.yellow('缺少 __csrf（账号类接口可能失败）')}`);
  if (state.savedAt) out(`  ${c.gray('登录于')} ${new Date(state.savedAt).toLocaleString('zh-CN')}`);
  out(c.gray(`\n配置文件: ${CONFIG_PATH}`));
}

function cmdLogout() {
  loginModuleClear();
  out(c.green('已清除本地登录态（Cookie / profile / 匿名 token）。'));
}

function loginModuleClear() {
  const { clearLoginCookie } = require('./request');
  clearLoginCookie();
}

function cmdConfig(o) {
  if (o._[0] === 'set' && o._[1]) {
    saveConfig({ [o._[1]]: o._[2] });
    out(c.green(`已设置 ${o._[1]}`));
    return;
  }
  const cfg = loadConfig();
  out(`配置文件: ${CONFIG_PATH}`);
  out(
    JSON.stringify(
      {
        cookie: cfg.cookie ? cfg.cookie.slice(0, 12) + '…(' + cfg.cookie.length + ' 字符)' : '(未设置)',
        loginAt: cfg.loginAt ? new Date(cfg.loginAt).toLocaleString('zh-CN') : null,
        profile: cfg.profile || null,
        deviceId: cfg.device?.deviceId ? cfg.device.deviceId.slice(0, 8) + '…' : null,
      },
      null,
      2,
    ),
  );
}

function help() {
  out(`
${c.bold('网易云音乐本地解析 CLI')}  ${c.gray('v1.0.0 · 零依赖 · 基于 weapi 加密')}

${c.bold('用法')}  nj <命令> [参数]        ${c.gray('不带参数 = 进入交互模式')}

${c.bold('交互模式')}
  nj                                直接进入交互 shell（也可 nj ui / nj i）
                                      ↑↓ 选择 · Enter 打开 · p 预览 · s 停止 · d 选择音质下载
                                      D 下载当前列表 · b 返回 · / 搜索 · q 退出

${c.bold('搜索 / 解析')}
  nj search <关键词> [--type song|album|artist|playlist] [--limit 20] [--offset 0]
  nj parse <链接|分享文本>          从 music.163.com 链接、163cn.tv 短链、App 分享文本里提取 ID
  nj toplist                        所有官方榜单

${c.bold('取数据')}
  nj song <ID...|歌曲链接>          歌曲详情（可逗号分隔多个 ID）
  nj url <ID|歌曲链接> [--level lossless]   取播放直链（standard/higher/exhigh/lossless，自动降级）
  nj preview <ID|链接>              在浏览器播放器中预览（也可 nj play，默认标准音质）
  nj lyric <ID|歌曲链接> [--trans]  歌词，--trans 显示翻译
  nj playlist <ID> [--all]          歌单详情 + 歌曲列表
  nj album <ID>                     专辑详情
  nj artist <ID> [--songs]          歌手信息 + 热门歌曲

${c.bold('下载')}
  nj download <ID|链接|分享文本> [-o 目录] [--level lossless] [--name "{artist} - {name}"]
  nj download --playlist <歌单ID> [-o 目录]    整张歌单批量下载
                                      终端未指定 --level 时可选择音质；试听文件带片段标记

${c.bold('登录（VIP 歌曲必须登录黑胶账号）')}
  nj login                          交互式选择：手机号密码 / 短信码 / 扫码 / Cookie
  nj login --browser chrome|edge|firefox|auto   直接复用浏览器里已登录的网易云登录态
  nj login --browser chrome --close-browser     先关掉浏览器再读（Cookie 库被独占时用）
  nj login --qr                     手机网易云 App 扫终端二维码
  nj login --phone 138... --password 密码
  nj login --phone 138... --send    先发短信验证码
  nj login --phone 138... --captcha 1234
  nj login --email you@mail.com --password 密码
  nj login --cookie "MUSIC_U=...; __csrf=..."
  nj login --cookie-file cookie.txt
  nj whoami / nj status             看当前账号、VIP 状态、Cookie 是否有效
  nj logout                         清除本地登录态
  nj config                         配置文件位置与内容摘要

${c.bold('全局')}
  --json                            输出原始 JSON
  -h, --help                        帮助
  -v, --version                     版本

${c.gray('示例')}
  nj search 晴天
  nj url 186016 --level lossless
  nj download 186016 -o ./music
  nj parse "分享周杰伦的单曲《晴天》: https://163cn.tv/xxxxx"
`);
}

async function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._.shift();

  if (!cmd) {
    if (process.stdin.isTTY && process.stdout.isTTY) return require('./interactive').run();
    return help();
  }
  if (flag(o, 'help', 'h') || cmd === 'help') return help();
  if (flag(o, 'version', 'v') || cmd === 'version') return out('netease-cli 1.0.0');

  const commands = {
    ui: () => require('./interactive').run(),
    i: () => require('./interactive').run(),
    interactive: () => require('./interactive').run(),
    search: cmdSearch,
    s: cmdSearch,
    song: cmdSong,
    url: cmdUrl,
    preview: cmdPreview,
    play: cmdPreview,
    lyric: cmdLyric,
    lrc: cmdLyric,
    playlist: cmdPlaylist,
    pl: cmdPlaylist,
    album: cmdAlbum,
    artist: cmdArtist,
    download: cmdDownload,
    dl: cmdDownload,
    parse: cmdParse,
    toplist: cmdToplist,
    login: cmdLogin,
    whoami: cmdWhoami,
    status: cmdWhoami,
    account: cmdWhoami,
    logout: cmdLogout,
    config: cmdConfig,
  };

  if (commands[cmd]) return commands[cmd](o);

  if (/^\d{3,}$/.test(cmd)) {
    o._.unshift(cmd);
    return cmdSong(o);
  }
  if (/^https?:\/\//.test(cmd) || /^163cn\.tv/.test(cmd)) {
    o._.unshift(cmd);
    return cmdParse(o);
  }

  out(c.red(`未知命令: ${cmd}`));
  help();
  process.exitCode = 1;
}

module.exports = { main, parseArgs };
