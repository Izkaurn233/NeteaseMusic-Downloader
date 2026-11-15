const { weapiRequest, eapiRequest, ensureAnonymousToken } = require('./request');

const SEARCH_TYPES = { song: 1, album: 10, artist: 100, playlist: 1000, mv: 1004, lyric: 1006 };

// 从高到低的音质链：请求无损但账号没权限时，逐级降到能拿到的最高音质
const LEVEL_ORDER = ['lossless', 'exhigh', 'higher', 'standard'];
const LEVEL_BR = { standard: 128000, higher: 192000, exhigh: 320000, lossless: 999000 };

async function search(keywords, { type = 'song', limit = 20, offset = 0 } = {}) {
  const t = typeof type === 'number' ? type : SEARCH_TYPES[type] ?? 1;
  return weapiRequest('/cloudsearch/pc', {
    s: keywords,
    type: t,
    limit: Number(limit),
    offset: Number(offset),
    total: true,
  });
}

async function songDetail(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  return weapiRequest('/v3/song/detail', {
    c: JSON.stringify(list.map((id) => ({ id: Number(id) }))),
    ids: JSON.stringify(list.map((id) => Number(id))),
  });
}

async function eapiUrl(id, level) {
  return eapiRequest('/api/song/enhance/player/url/v1', {
    ids: JSON.stringify([Number(id)]),
    level,
    encodeType: 'flac',
  });
}

async function weapiUrlV1(id, level) {
  return weapiRequest('/song/enhance/player/url/v1', {
    ids: JSON.stringify([Number(id)]),
    level,
    encodeType: 'flac',
  });
}

async function weapiUrlLegacy(id, level) {
  return weapiRequest('/song/enhance/player/url', {
    ids: JSON.stringify([Number(id)]),
    br: LEVEL_BR[level] || 320000,
  });
}

/**
 * 取播放地址。顺序：eapi（会员直链只有这里稳）→ weapi v1 → weapi 老接口，
 * 每一层内部再按 lossless→exhigh→higher→standard 降级。
 * 返回结构固定为 { data: [track] }，track._source 标记实际生效的接口和音质。
 */
async function songUrl(id, level = 'exhigh') {
  await ensureAnonymousToken();
  const start = Math.max(0, LEVEL_ORDER.indexOf(level));
  const chain = LEVEL_ORDER.slice(start);
  const attempts = [
    ['eapi', eapiUrl],
    ['weapi-v1', weapiUrlV1],
    ['weapi-legacy', weapiUrlLegacy],
  ];
  const errors = [];
  let last = null;

  for (const [source, fn] of attempts) {
    for (const lv of chain) {
      try {
        const res = await fn(id, lv);
        const track = res?.data?.[0];
        if (track) {
          track._source = source;
          track._requestedLevel = level;
          last = res;
        }
        if (track?.url) {
          if (lv !== level) track._downgradedFrom = level;
          return res;
        }
        // 拿到了对象但没有 url：VIP/版权受限，降级音质也救不回来，直接换下一个接口
        if (track && track.url === null) break;
      } catch (err) {
        errors.push(`${source}/${lv}: ${err.message}`);
      }
    }
  }
  if (last) return last;
  throw new Error(`所有取链方式都失败：${errors.slice(0, 3).join(' | ') || '无返回'}`);
}

async function lyric(id) {
  return weapiRequest('/song/lyric', { id: Number(id), lv: -1, kv: -1, tv: -1 });
}

async function playlistDetail(id, limit = 1000) {
  return weapiRequest('/v6/playlist/detail', { id: Number(id), n: Number(limit), s: 8 });
}

async function album(id) {
  return weapiRequest(`/v1/album/${Number(id)}`, {});
}

async function artist(id) {
  return weapiRequest(`/v1/artist/${Number(id)}`, { id: Number(id) });
}

async function artistSongs(id, limit = 50, offset = 0) {
  return weapiRequest('/v1/artist/songs', {
    id: Number(id),
    order: 'time',
    limit: Number(limit),
    offset: Number(offset),
    private_cloud: 'true',
    work_type: 1,
  });
}

async function toplist() {
  return weapiRequest('/toplist/detail', {});
}

async function account() {
  try {
    return await eapiRequest('/api/nuser/account/get', {});
  } catch {
    return weapiRequest('/w/nuser/account/get', {});
  }
}

async function userPlaylist(uid, limit = 100, offset = 0) {
  return weapiRequest('/user/playlist', { uid: Number(uid), limit: Number(limit), offset: Number(offset) });
}

module.exports = {
  SEARCH_TYPES,
  LEVEL_ORDER,
  search,
  songDetail,
  songUrl,
  lyric,
  playlistDetail,
  album,
  artist,
  artistSongs,
  toplist,
  account,
  userPlaylist,
};
