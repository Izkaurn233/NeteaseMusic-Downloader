const crypto = require('crypto');
const { weapi } = require('./crypto');
const { eapiParams } = require('./eapi');
const { loadConfig, saveConfig } = require('./config');

const DOMAIN = 'https://music.163.com';
const EAPI_DOMAIN = 'https://interface.music.163.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomAlnum(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function identity() {
  const cfg = loadConfig();
  if (cfg.device && cfg.device.nuid) return cfg.device;
  const nuid = randomHex(16);
  const device = {
    nuid,
    nnidAt: Date.now(),
    wnmcid: `${randomAlnum(6)}.${Date.now()}.01.0`,
    deviceId: randomAlnum(32),
  };
  saveConfig({ device });
  return device;
}

/** 把 "a=1; b=2" 这样的字符串解析成 Map，值里允许含 '='，逗号，空格 */
function parseCookieString(raw) {
  const map = new Map();
  const text = Array.isArray(raw) ? raw.join('; ') : String(raw || '');
  for (const part of text.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    map.set(key, val);
  }
  return map;
}

/** 从 Set-Cookie 数组里挑出真正属于登录态的键值 */
function pickCookie(setCookies, keys) {
  const out = {};
  for (const line of setCookies || []) {
    const first = String(line).split(';')[0];
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const key = first.slice(0, idx).trim();
    const val = first.slice(idx + 1).trim();
    if (!keys.includes(key)) continue;
    if (!val) continue; // 服务端用它来清除 cookie，忽略
    out[key] = val;
  }
  return out;
}

function cookieMap() {
  const cfg = loadConfig();
  const dev = identity();
  const map = new Map([
    ['os', 'pc'],
    ['appver', '2.10.6'],
    ['channel', 'netease'],
    ['deviceId', dev.deviceId],
    ['_ntes_nuid', dev.nuid],
    ['_ntes_nnid', `${dev.nuid},${dev.nnidAt}`],
    ['WNMCID', dev.wnmcid],
    ['NMTID', randomHex(8)],
    ['WEVNSM', '1.0.0'],
  ]);
  // 登录态优先级高于匿名态：有 MUSIC_U 时不要再叠加 MUSIC_A
  const user = parseCookieString(cfg.cookie);
  if (!user.has('MUSIC_U') && cfg.musicA) map.set('MUSIC_A', cfg.musicA);
  for (const [k, v] of user) map.set(k, v);
  return map;
}

function cookieHeader() {
  return [...cookieMap()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function cookieValue(key) {
  return cookieMap().get(key) || '';
}

function isLoggedIn() {
  return Boolean(cookieValue('MUSIC_U'));
}

function saveLoginCookie(pairs) {
  const merged = new Map(parseCookieString(loadConfig().cookie));
  for (const [k, v] of Object.entries(pairs || {})) merged.set(k, v);
  const text = [...merged].map(([k, v]) => `${k}=${v}`).join('; ');
  saveConfig({ cookie: text, loginAt: Date.now() });
  return text;
}

function clearLoginCookie() {
  saveConfig({ cookie: '', profile: null, loginAt: null, musicA: null, musicATs: null });
}

function checkJson(json, res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  Object.defineProperty(json, 'cookies', { value: setCookies, enumerable: false });
  if (json.code !== undefined && ![200, 201, 301, 302, 800, 801, 802, 803].includes(Number(json.code))) {
    const err = new Error(`${json.message || json.msg || '接口错误'} (code=${json.code})`);
    err.code = Number(json.code);
    err.body = json;
    throw err;
  }
  return json;
}

async function weapiRequest(path, data = {}, opts = {}) {
  const payload = { ...data, csrf_token: opts.csrf ?? cookieValue('__csrf') };
  const { params, encSecKey } = weapi(payload);
  const body = new URLSearchParams({ params, encSecKey }).toString();

  const res = await fetch(DOMAIN + '/weapi' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com',
      Origin: 'https://music.163.com',
      'User-Agent': UA,
      Cookie: cookieHeader(),
      ...(opts.headers || {}),
    },
    body,
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error(`接口返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return checkJson(json, res);
}

/**
 * eapi：会员直链、播放地址、部分账号接口只有在 eapi 上才返回真实数据。
 * 路径写 "/api/..."（不带 /eapi 前缀），内部拼成 interface.music.163.com/eapi/api/...
 */
async function eapiRequest(path, payload = {}, opts = {}) {
  const full = path.startsWith('/api/') ? path : path;
  const params = eapiParams(full, { ...payload, header: payload.header ?? headerBlob() });
  const res = await fetch(EAPI_DOMAIN + '/eapi' + full, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com',
      Origin: 'https://music.163.com',
      'User-Agent': UA,
      Cookie: cookieHeader(),
      ...(opts.headers || {}),
    },
    body: new URLSearchParams({ params }).toString(),
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error(`eapi 返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return checkJson(json, res);
}

function headerBlob(extra = {}) {
  const cfg = loadConfig();
  const dev = cfg.device || identity();
  return JSON.stringify({
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    deviceId: dev.deviceId,
    appver: '2.10.6',
    versioncode: '201006',
    mobilename: '',
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: '1920x1080',
    __csrf: cookieValue('__csrf'),
    os: 'pc',
    channel: 'netease',
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
    ...extra,
  });
}

function xorDeviceId(deviceId) {
  const KEY = '3go8&$8*3*3h0k(2)2';
  const bytes = Buffer.from(deviceId, 'utf8');
  const keyBytes = Buffer.from(KEY, 'utf8');
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
  return crypto.createHash('md5').update(out).digest('base64');
}

let tokenPromise = null;

async function ensureAnonymousToken() {
  const cfg = loadConfig();
  if (cfg.cookie && cfg.cookie.includes('MUSIC_U=')) return;
  if (cfg.musicA && Date.now() - (cfg.musicATs || 0) < 30 * 24 * 3600 * 1000) return;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    try {
      const dev = identity();
      const username = Buffer.from(`${dev.deviceId} ${xorDeviceId(dev.deviceId)}`, 'utf8').toString('base64');
      const res = await weapiRequest('/register/anonimous', { username });
      const musicA = (res.cookies || [])
        .map((c) => (String(c).match(/MUSIC_A=([^;]+)/) || [])[1])
        .filter(Boolean)
        .pop();
      if (musicA) saveConfig({ musicA, musicATs: Date.now() });
      return musicA;
    } catch {
      return null;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}

module.exports = {
  weapiRequest,
  eapiRequest,
  ensureAnonymousToken,
  cookieHeader,
  cookieValue,
  cookieMap,
  parseCookieString,
  pickCookie,
  saveLoginCookie,
  clearLoginCookie,
  isLoggedIn,
  headerBlob,
  UA,
  DOMAIN,
  EAPI_DOMAIN,
};
