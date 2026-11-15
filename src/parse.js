const SHORT_LINK_RE = /^https?:\/\/(?:163cn\.tv|y\.music\.163\.com\/[a-z]\/[a-z]+)\//i;
const LINK_RE = /(https?:\/\/[^\s"'<>]+)/i;

const TYPE_BY_KEYWORD = [
  [/playlist|my\/music\/|discover\/toplist/, 'playlist'],
  [/album/, 'album'],
  [/artist/, 'artist'],
  [/song|m\/song|#\/song/, 'song'],
];

function parseIdFromUrl(url) {
  const m = url.match(/[?&#/](?:id|songid|albumid|playlistid|artistid)=?\/?(\d{3,})/i) ||
    url.match(/\/(\d{5,})(?:\/)?(?:[?#]|$)/);
  if (!m) return null;
  let type = 'song';
  for (const [re, t] of TYPE_BY_KEYWORD) {
    if (re.test(url)) {
      type = t;
      break;
    }
  }
  return { id: m[1], type };
}

async function resolveShortLink(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      },
      signal: AbortSignal.timeout(12000),
    });
    return res.url || url;
  } catch {
    return url;
  }
}

async function parseTarget(input) {
  const text = String(input).trim();
  if (/^\d{3,}$/.test(text)) return { id: text, type: 'song', source: text };

  const link = text.match(LINK_RE)?.[1] || (text.startsWith('163cn.tv') ? `https://${text}` : null);
  if (!link) return null;

  const finalUrl = SHORT_LINK_RE.test(link) || /163cn\.tv/.test(link) ? await resolveShortLink(link) : link;
  const parsed = parseIdFromUrl(finalUrl);
  if (!parsed) return null;
  return { ...parsed, source: finalUrl };
}

async function songId(input) {
  const target = await parseTarget(input);
  if (!target || target.type !== 'song') throw new Error('请输入歌曲 ID、歌曲链接或歌曲分享文本。');
  return target.id;
}

module.exports = { parseTarget, parseIdFromUrl, resolveShortLink, songId };
