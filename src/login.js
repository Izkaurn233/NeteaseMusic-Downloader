const crypto = require('crypto');
const { weapiRequest, eapiRequest, pickCookie, saveLoginCookie, isLoggedIn, cookieValue } = require('./request');
const { loadConfig, saveConfig } = require('./config');

const LOGIN_KEYS = ['MUSIC_U', '__csrf', 'NMTID', 'MUSIC_A_T', 'MUSIC_R_T', 'MUSIC_SNS'];

const md5 = (text) => crypto.createHash('md5').update(String(text), 'utf8').digest('hex');

/**
 * -462 / -460 是网易的风控码（要人机验证 / 判定网络环境异常），
 * 与账号密码对错无关。这里把话说明白，并给出实际能走通的两条替代路径。
 */
function explainRisk(err) {
  const code = Number(err?.code);
  if (code === -462 || code === -460) {
    err.message +=
      '\n  这是接口风控（需要人机验证），不是账号或密码错误。可以：\n' +
      '    1) nj login --browser chrome   直接复用浏览器里已登录的网易云登录态\n' +
      '    2) nj login --cookie "MUSIC_U=...; __csrf=..."   从浏览器 F12 手动复制\n' +
      '    3) 换手机热点 / 家用宽带再试扫码或短信登录';
  }
  return err;
}

const VIP_LABEL = {
  '0': '普通用户',
  '10': '黑胶音乐包',
  '11': '黑胶 VIP',
  '100': '黑胶 VIP',
};

function profileSummary(profile = {}, account = {}) {
  const vipType = Number(profile.vipType ?? account.vipType ?? 0);
  return {
    nickname: profile.nickname || '',
    userId: profile.userId || account.id || '',
    vipType,
    vip: vipType > 0,
    vipLabel: VIP_LABEL[String(vipType)] || (vipType > 0 ? `VIP(${vipType})` : '普通用户'),
  };
}

/** 用登录态拉一次账号信息，既做校验也做展示 */
async function fetchAccount() {
  const errors = [];
  const tryOne = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      errors.push(err);
      return null;
    }
  };
  let res = await tryOne(() => eapiRequest('/api/nuser/account/get', {}));
  if (!res || !res.profile) {
    res = (await tryOne(() => weapiRequest('/w/nuser/account/get', {}))) || res;
  }
  const profile = res?.profile;
  if (!profile) {
    const risk = errors.find((e) => [ -462, -460 ].includes(Number(e.code)));
    const err = new Error(
      risk
        ? `账号校验被网易风控拦截（${risk.message}）—— cookie 本身可能是好的，稍后重试或换网络`
        : '服务端返回里没有 profile，登录态无效',
    );
    err.risk = Boolean(risk);
    err.details = errors.map((e) => e.message);
    throw err;
  }
  const summary = profileSummary(profile, res.account);
  saveConfig({ profile: summary });
  return { raw: res, summary };
}

/** VIP 详情：黑胶等级、到期时间（拿不到就退回 profile 里的 vipType） */
async function vipInfo() {
  try {
    const res = await eapiRequest('/api/vip/info', {});
    const d = res.data || {};
    return {
      redVipLevel: d.redVipLevel ?? res.redVipLevel ?? 0,
      redVipAnnualCount: d.redVipAnnualCount ?? 0,
      musicPackage: d.musicPackage?.vipCode ?? 0,
      expireAt: d.redVipLevel > 0 ? d.associator?.expireTime || null : null,
    };
  } catch {
    return null;
  }
}

function persist(setCookies, extra = {}) {
  const pairs = pickCookie(setCookies, LOGIN_KEYS);
  if (!pairs.MUSIC_U) {
    const err = new Error('登录响应里没有 MUSIC_U，Cookie 未能保存');
    err.body = extra;
    throw err;
  }
  saveLoginCookie(pairs);
  return pairs;
}

/** 手机号 + 密码（密码走 md5 后 weapi 上传，不落盘） */
async function loginByPhonePassword(phone, password, { countrycode = '86' } = {}) {
  const res = await weapiRequest('/login/cellphone', {
    phone: String(phone),
    countrycode: String(countrycode),
    password: md5(password),
    rememberLogin: 'true',
  }).catch((e) => {
    throw explainRisk(e);
  });
  persist(res.cookies, res);
  return res;
}

/** 邮箱 + 密码 */
async function loginByEmail(username, password) {
  const res = await weapiRequest('/login', {
    username: String(username),
    password: md5(password),
    rememberLogin: 'true',
  }).catch((e) => {
    throw explainRisk(e);
  });
  persist(res.cookies, res);
  return res;
}

/** 发送短信验证码（ctcode 默认 86） */
async function sendSmsCaptcha(phone, { ctcode = '86' } = {}) {
  return weapiRequest('/sms/captcha/sent', {
    cellphone: String(phone),
    ctcode: String(ctcode),
  }).catch((e) => {
    throw explainRisk(e);
  });
}

/** 手机号 + 短信验证码 */
async function loginByPhoneCaptcha(phone, captcha, { countrycode = '86' } = {}) {
  const res = await weapiRequest('/login/cellphone', {
    phone: String(phone),
    countrycode: String(countrycode),
    captcha: String(captcha),
    rememberLogin: 'true',
  }).catch((e) => {
    throw explainRisk(e);
  });
  persist(res.cookies, res);
  return res;
}

/** 二维码登录：拿 unikey → 轮询扫码状态 */
async function qrCreate() {
  const res = await weapiRequest('/login/qrcode/unikey', { type: 1 }).catch((e) => {
    throw explainRisk(e);
  });
  if (!res.unikey) throw new Error('没拿到二维码 key：' + JSON.stringify(res).slice(0, 200));
  return {
    unikey: res.unikey,
    content: `https://music.163.com/login?codekey=${res.unikey}`,
  };
}

async function qrPoll(unikey) {
  const res = await weapiRequest('/login/qrcode/client/login', { key: unikey, type: 1 }).catch((e) => {
    throw explainRisk(e);
  });
  const code = Number(res.code);
  let message = '等待扫码';
  if (code === 800) message = '二维码已过期';
  else if (code === 801) message = '等待扫码';
  else if (code === 802) message = '已扫码，等待手机确认';
  else if (code === 803) message = '登录成功';
  return { code, message, res, cookies: res.cookies || [] };
}

async function qrLogin({ onRender, onStatus, timeoutMs = 180000, intervalMs = 2000 } = {}) {
  const { unikey, content } = await qrCreate();
  if (onRender) onRender(content);
  const started = Date.now();
  let lastStatus = '';
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('二维码登录超时');
    const r = await qrPoll(unikey);
    if (onStatus && r.message !== lastStatus) {
      lastStatus = r.message;
      onStatus(r.message);
    }
    if (r.code === 803) {
      persist(r.cookies, r.res);
      return r.res;
    }
    if (r.code === 800) throw new Error('二维码已过期，请重新执行 nj login --qr');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 兼容各种粘贴来源：
 * - 纯 "MUSIC_U=..; __csrf=.."
 * - DevTools 里复制的整段请求头（含 "cookie: " 前缀、换行、其他头）
 * - 带引号的值
 */
function normalizeCookieInput(raw) {
  let text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!text) return '';
  const headerLine = text.match(/(?:^|[\r\n])\s*cookie\s*:\s*([^\r\n]+)/i);
  if (headerLine) text = headerLine[1];
  text = text.replace(/[\r\n]+/g, ' ').trim();
  text = text.replace(/^["']|["']$/g, '');
  const pairs = [];
  for (const part of text.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim().replace(/^["']|["']$/g, '');
    const val = part.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!key) continue;
    pairs.push(`${key}=${val}`);
  }
  return pairs.join('; ');
}

/** 直接粘贴浏览器 / 客户端里的 cookie 串（或整段请求头） */
async function loginByCookie(raw) {
  const text = normalizeCookieInput(raw);
  if (!text || !text.includes('=')) {
    throw new Error(
      'cookie 里没有 key=value。MUSIC_U 是 HttpOnly，document.cookie 读不到；' +
        '请在 DevTools → Application → Cookies → 选中 MUSIC_U 行，从下方 Cookie Value 框复制完整值，' +
        '或 Network → 任一 music.163.com 请求 → Request Headers → cookie 整行复制。',
    );
  }
  const pairs = {};
  for (const part of text.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    pairs[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  if (!pairs.MUSIC_U) {
    throw new Error('这段 cookie 里没有 MUSIC_U，无法作为登录态使用（只有 __csrf 之类不够）');
  }
  saveLoginCookie(pairs);
  return text;
}

async function accountState() {
  const cfg = loadConfig();
  if (!isLoggedIn() && !(cfg.cookie || '').includes('MUSIC_U=')) {
    return { loggedIn: false, cookie: false, profile: cfg.profile || null, vip: null };
  }
  let error = null;
  const acc = await fetchAccount().catch((err) => {
    error = err;
    return null;
  });
  const vip = acc ? await vipInfo() : null;
  return {
    loggedIn: Boolean(acc),
    cookie: true,
    profile: acc?.summary || cfg.profile || null,
    raw: acc?.raw || null,
    vip,
    csrf: Boolean(cookieValue('__csrf')),
    savedAt: cfg.loginAt || null,
    risk: Boolean(error?.risk),
    error: error ? error.message : null,
  };
}

module.exports = {
  md5,
  normalizeCookieInput,
  loginByCookie,
  loginByPhonePassword,
  loginByEmail,
  sendSmsCaptcha,
  loginByPhoneCaptcha,
  qrCreate,
  qrPoll,
  qrLogin,
  fetchAccount,
  vipInfo,
  accountState,
  profileSummary,
  VIP_LABEL,
};
