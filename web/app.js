'use strict';

const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="nj-token"]').content;
const state = { songs: [], selected: null, playing: null, query: '', offset: 0, total: 0, searchVersion: 0, playVersion: 0 };
const audio = $('audio');
let snackTimer;

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function text(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function time(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function notify(message) {
  $('snackbar').textContent = message;
  $('snackbar').hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { $('snackbar').hidden = true; }, 6500);
}

async function api(route, body) {
  let response;
  try {
    response = await fetch(route, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-NJ-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Error('连接已断开，请重新启动网页版。'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}

function coverImage(song) {
  if (!song.cover || !/^https?:\/\//i.test(song.cover)) return null;
  const img = document.createElement('img');
  img.alt = song.album ? `${song.album} 专辑封面` : '专辑封面';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.src = song.cover.replace(/^http:/i, 'https:');
  img.onerror = () => img.remove();
  return img;
}

function accessBadge(song) {
  return text('span', 'access-badge', song.badge.replace(/^\[|\]$/g, ''));
}

function selectSong(song) {
  state.selected = song;
  $('selected-name').textContent = song.name;
  $('selected-artist').textContent = song.artist || '未知歌手';
  $('selected-album').textContent = [song.album, time(song.duration / 1000)].filter(Boolean).join(' · ');
  $('selected-id').textContent = 'ID ' + song.id;
  $('selected-badge').textContent = song.badge.replace(/^\[|\]$/g, '');
  $('selected-badge').hidden = !song.badge;
  const old = $('selected-cover').querySelector('img');
  if (old) old.remove();
  const img = coverImage(song);
  if (img) $('selected-cover').append(img);
  for (const id of ['preview', 'download', 'lyrics']) $(id).disabled = false;
  const info = document.querySelector('.detail-info');
  info.classList.remove('changing');
  void info.offsetWidth;
  info.classList.add('changing');
  document.querySelectorAll('.song-row').forEach((row) => row.classList.toggle('selected', row.dataset.id === song.id));
}

function actionButton(name, label, action) {
  const button = document.createElement('button');
  button.className = 'icon-button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  button.onclick = action;
  return button;
}

function renderSongs() {
  const list = $('song-list');
  list.replaceChildren();
  for (const [index, song] of state.songs.entries()) {
    const row = document.createElement('div');
    row.className = 'song-row';
    row.dataset.id = song.id;
    row.style.animationDelay = Math.min(index * 28, 280) + 'ms';
    row.classList.toggle('selected', state.selected?.id === song.id);
    const main = document.createElement('button');
    main.className = 'song-main';
    main.setAttribute('aria-label', '选择歌曲 ' + song.name);
    main.onclick = () => selectSong(song);
    const thumb = text('span', 'song-thumb', '♫');
    const img = coverImage(song);
    if (img) { thumb.textContent = ''; thumb.append(img); }
    const info = document.createElement('span');
    info.className = 'song-text';
    if (song.badge) info.append(accessBadge(song));
    info.append(text('strong', 'song-name', song.name), text('span', 'song-artist', song.artist || '未知歌手'));
    main.append(thumb, info);
    const album = text('span', 'song-album', song.album || '—');
    album.title = song.album;
    const actions = document.createElement('div');
    actions.className = 'song-actions';
    actions.append(
      actionButton('play', '预览 ' + song.name, () => { selectSong(song); playSong(song); }),
      actionButton('download', '下载 ' + song.name, () => { selectSong(song); downloadSong(song); }),
    );
    row.append(main, album, text('span', 'song-duration', time(song.duration / 1000)), actions);
    list.append(row);
  }
  $('empty-state').hidden = state.songs.length > 0;
  $('pagination').hidden = state.total <= 20;
  $('previous').disabled = state.offset === 0;
  $('next').disabled = state.offset + 20 >= state.total;
  $('page-label').textContent = `第 ${Math.floor(state.offset / 20) + 1} 页`;
}

async function search(query, offset = 0) {
  query = query.trim();
  if (!query) return;
  const version = ++state.searchVersion;
  $('search-submit').disabled = true;
  $('search-submit').textContent = '搜索中…';
  $('search-form').classList.add('loading');
  $('result-count').textContent = '正在寻找好音乐';
  try {
    const result = await api('/api/search?q=' + encodeURIComponent(query) + '&offset=' + offset);
    if (version !== state.searchVersion) return;
    state.songs = result.songs;
    state.total = result.total;
    state.query = query;
    state.offset = offset;
    $('results-title').textContent = result.direct ? '你的歌曲' : '搜索结果';
    $('result-count').textContent = `共 ${result.total} 首`;
    renderSongs();
    if (result.songs.length) selectSong(result.songs[0]);
    else {
      $('empty-state').querySelector('h3').textContent = '还没找到这首歌';
      $('empty-state').querySelector('p').textContent = '换个关键词，或试试直接粘贴歌曲链接 / ID。';
    }
  } catch (err) {
    if (version === state.searchVersion) { $('result-count').textContent = '搜索未完成'; notify(err.message); }
  } finally {
    if (version === state.searchVersion) {
      $('search-submit').disabled = false;
      $('search-form').classList.remove('loading');
      $('search-submit').replaceChildren(document.createTextNode('搜索'), icon('arrow'));
    }
  }
}

async function playSong(song) {
  if (!song) return;
  const version = ++state.playVersion;
  $('preview').disabled = true;
  notify('正在准备预览…');
  try {
    const result = await api('/api/playback', { input: song.id, level: 'standard' });
    if (version !== state.playVersion) return;
    state.playing = result.song;
    $('player').hidden = false;
    $('player-name').textContent = result.song.name;
    $('player-artist').textContent = result.song.artist;
    $('player-quality').textContent = result.quality;
    $('player-cover').textContent = '♫';
    const img = coverImage(result.song);
    if (img) $('player-cover').replaceChildren(img);
    $('elapsed').textContent = '0:00';
    $('total-time').textContent = time(result.song.duration / 1000);
    $('seek').value = 0;
    audio.src = result.mediaUrl;
    try { await audio.play(); } catch { notify('音频已准备好，点击底部播放按钮开始。'); }
    if (result.trial) notify(`当前播放${result.trial}，非完整版。`);
    else if (!audio.paused) { clearTimeout(snackTimer); $('snackbar').hidden = true; }
  } catch (err) { notify(err.message); }
  finally { if (version === state.playVersion) $('preview').disabled = false; }
}

async function downloadSong(song) {
  if (!song) return;
  $('download').disabled = true;
  notify('正在获取所选音质的下载地址…');
  try {
    const result = await api('/api/download', { input: song.id, level: $('quality').value });
    const link = document.createElement('a');
    link.href = result.mediaUrl;
    link.download = result.filename;
    document.body.append(link);
    link.click();
    link.remove();
    notify(result.trial ? `正在下载${result.trial}，文件名已标记试听。` : `已交给浏览器下载 · ${result.quality}${result.downgraded ? '（已按可用资源降级）' : ''}`);
  } catch (err) { notify(err.message); }
  finally { $('download').disabled = !state.selected; }
}

function syncPlayer() {
  const playing = !audio.paused && !audio.ended;
  $('toggle-play').setAttribute('aria-label', playing ? '暂停' : '播放');
  $('toggle-play').replaceChildren(icon(playing ? 'pause' : 'play'));
}

$('search-form').addEventListener('submit', (event) => { event.preventDefault(); search($('query').value); });
document.addEventListener('pointerdown', (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = button.getBoundingClientRect();
  const diameter = Math.max(rect.width, rect.height) * 2;
  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  ripple.style.width = ripple.style.height = diameter + 'px';
  ripple.style.left = event.clientX - rect.left - diameter / 2 + 'px';
  ripple.style.top = event.clientY - rect.top - diameter / 2 + 'px';
  button.append(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
});
document.querySelectorAll('[data-query]').forEach((button) => {
  button.onclick = () => { $('query').value = button.dataset.query; search(button.dataset.query); };
});
$('previous').onclick = () => search(state.query, Math.max(0, state.offset - 20));
$('next').onclick = () => search(state.query, state.offset + 20);
$('preview').onclick = () => playSong(state.selected);
$('download').onclick = () => downloadSong(state.selected);
$('player-download').onclick = () => downloadSong(state.playing);
$('toggle-play').onclick = async () => {
  if (!audio.src) return;
  if (audio.paused) {
    try { await audio.play(); } catch { notify('播放失败，请重新点击预览歌曲。'); }
  } else audio.pause();
};
$('stop-playback').onclick = () => { audio.pause(); audio.currentTime = 0; };
$('seek').oninput = () => { if (Number.isFinite(audio.duration)) audio.currentTime = Number($('seek').value) / 100 * audio.duration; };
$('volume').oninput = () => { audio.volume = Number($('volume').value); audio.muted = false; updateMute(); };
function updateMute() {
  $('mute').replaceChildren(icon(audio.muted || audio.volume === 0 ? 'muted' : 'volume'));
  $('mute').setAttribute('aria-label', audio.muted ? '取消静音' : '静音');
}
$('mute').onclick = () => { audio.muted = !audio.muted; updateMute(); };
audio.volume = .7;
for (const event of ['play', 'pause', 'ended']) audio.addEventListener(event, syncPlayer);
audio.addEventListener('timeupdate', () => {
  $('elapsed').textContent = time(audio.currentTime);
  $('seek').value = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
});
audio.addEventListener('loadedmetadata', () => { $('total-time').textContent = time(audio.duration); });
audio.addEventListener('error', () => notify('音频无法播放或地址已过期，请重新点击预览。'));

$('lyrics').onclick = async () => {
  if (!state.selected) return;
  const song = state.selected;
  $('lyrics-title').textContent = song.name;
  $('lyrics-content').textContent = '正在加载歌词…';
  $('lyrics-dialog').showModal();
  try {
    const result = await api('/api/lyric?id=' + encodeURIComponent(song.id));
    $('lyrics-content').textContent = result.lyric ? result.lyric.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim() + (result.translation ? '\n\n译文\n' + result.translation.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim() : '') : '这首歌暂时没有歌词。';
  } catch (err) { $('lyrics-content').textContent = err.message; }
};
$('close-lyrics').onclick = () => $('lyrics-dialog').close();
$('lyrics-dialog').addEventListener('click', (event) => { if (event.target === $('lyrics-dialog')) $('lyrics-dialog').close(); });

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme').setAttribute('aria-label', theme === 'dark' ? '切换浅色模式' : '切换深色模式');
}
try {
  const theme = localStorage.getItem('nj-theme');
  applyTheme(theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const quality = localStorage.getItem('nj-quality');
  if (['standard', 'higher', 'exhigh', 'lossless'].includes(quality)) $('quality').value = quality;
} catch { applyTheme('light'); }
$('theme').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('nj-theme', theme); } catch {}
};
$('quality').onchange = () => { try { localStorage.setItem('nj-quality', $('quality').value); } catch {} };
api('/api/status').then((status) => {
  $('account').textContent = status.loggedIn ? (status.profile?.nickname || '已保存登录态') + (status.profile?.vip ? ' · VIP' : '') : '未登录 · VIP 歌曲仅试听';
}).catch((err) => notify(err.message));
