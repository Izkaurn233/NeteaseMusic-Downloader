const { c } = require('./format');

const LEVELS = ['standard', 'higher', 'exhigh', 'lossless'];
const LEVEL_LABEL = { standard: '标准 128k', higher: '较高 192k', exhigh: '极高 320k', lossless: '无损' };

function withPrivileges(songs, privileges = []) {
  const byId = new Map((privileges || []).map((p) => [String(p.id), p]));
  return (songs || []).map((song) => ({ ...song, privilege: byId.get(String(song.id)) || song.privilege }));
}

function songBadge(song = {}) {
  const fee = Number(song.fee ?? song.privilege?.fee ?? 0);
  if (fee === 1) return '[VIP：非VIP只能下载30秒试听]';
  if (fee === 8) return '[VIP下载]';
  if (fee === 4) return '[单独付费]';
  return '';
}

function songTitle(song = {}) {
  return [songBadge(song), song.name || '未知歌曲'].filter(Boolean).join(' ');
}

function trialSeconds(track = {}) {
  const info = track.freeTrialInfo;
  if (!info || typeof info !== 'object') return null;
  const seconds = Number(info.end) - Number(info.start);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function trialLabel(track = {}) {
  const seconds = trialSeconds(track);
  if (seconds !== null) return `试听${seconds}秒`;
  return track.freeTrialInfo && typeof track.freeTrialInfo === 'object' ? '试听片段' : '';
}

function playbackLabel(track = {}) {
  return [LEVEL_LABEL[track.level] || track.level, trialLabel(track)].filter(Boolean).join(' · ');
}

async function chooseDownloadLevel(ask, current = 'lossless') {
  process.stdout.write('\n选择下载音质（实际音质以账号权限和歌曲资源为准）：\n');
  LEVELS.forEach((level, i) => {
    process.stdout.write(`  ${i + 1}  ${LEVEL_LABEL[level]}${level === current ? c.gray('（默认）') : ''}\n`);
  });
  for (;;) {
    const answer = await ask(`  音质 [1-4 / 回车 ${LEVEL_LABEL[current]} / q 取消]: `);
    if (answer === null) return null;
    const value = String(answer).trim().toLowerCase();
    if (['q', 'b', 'esc', 'escape'].includes(value)) return null;
    if (!value) return current;
    const level = /^[1-4]$/.test(value) ? LEVELS[Number(value) - 1] : value;
    if (LEVELS.includes(level)) return level;
    process.stdout.write(c.yellow('请输入 1-4 或 standard/higher/exhigh/lossless。\n'));
  }
}

module.exports = { LEVELS, LEVEL_LABEL, withPrivileges, songBadge, songTitle, trialSeconds, trialLabel, playbackLabel, chooseDownloadLevel };
