const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TARGET_HOSTS = ['music.163.com', '163.com', 'interface.music.163.com'];

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function roamingAppData() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

/** 枚举本机 Chromium 系浏览器的 Cookie 库 */
function chromiumRoots() {
  // NJ_CHROMIUM_DIRS 可指向自定义的 User Data 目录（便携版浏览器 / 自动化测试）
  const custom = process.env.NJ_CHROMIUM_DIRS;
  if (custom) {
    return custom
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir, i) => [`custom${i + 1}`, dir]);
  }
  const base = localAppData();
  return [
    ['chrome', path.join(base, 'Google', 'Chrome', 'User Data')],
    ['edge', path.join(base, 'Microsoft', 'Edge', 'User Data')],
    ['brave', path.join(base, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['chromium', path.join(base, 'Chromium', 'User Data')],
    ['360se', path.join(base, '360Chrome', 'Chrome', 'User Data')],
    ['qqbrowser', path.join(base, 'Tencent', 'QQBrowser', 'User Data')],
  ];
}

function chromiumTargets() {
  const out = [];
  for (const [name, dir] of chromiumRoots()) {
    if (!fs.existsSync(dir)) continue;
    const localState = path.join(dir, 'Local State');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^(Default|Profile \d+|Guest Profile)$/i.test(entry.name)) continue;
      for (const sub of ['Network\\Cookies', 'Cookies']) {
        const file = path.join(dir, entry.name, sub);
        if (fs.existsSync(file)) {
          out.push({ browser: name, profile: entry.name, db: file, localState });
          break;
        }
      }
    }
  }
  return out;
}

function firefoxTargets() {
  const base = path.join(roamingAppData(), 'Mozilla', 'Firefox', 'Profiles');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(base, entry.name, 'cookies.sqlite');
    if (fs.existsSync(file)) out.push({ browser: 'firefox', profile: entry.name, db: file });
  }
  return out;
}

function chromiumProfiles() {
  return [...chromiumTargets(), ...firefoxTargets()];
}

/** 拷一份 Cookie 库到临时目录，避免浏览器进程锁住文件 */
function copyDb(dbPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nj-cookie-'));
  const dest = path.join(dir, 'cookies.db');
  copyShared(dbPath, dest);
  for (const suffix of ['-wal', '-shm']) {
    const extra = dbPath + suffix;
    if (fs.existsSync(extra)) {
      try {
        copyShared(extra, dest + suffix);
      } catch {}
    }
  }
  return { dir, file: dest };
}

/**
 * 浏览器运行时 Cookie 库被独占，CopyFile 会 EBUSY。
 * 这里用 fs.open 自带的 FILE_SHARE_READ|WRITE|DELETE 共享模式手动流式复制。
 */
function copyShared(src, dest) {
  let srcFd;
  try {
    srcFd = fs.openSync(src, 'r');
  } catch (err) {
    throw new Error(
      `Cookie 库被浏览器独占（${err.code || err.message}）。先完全退出该浏览器再试，` +
        '或改用 nj login --cookie "MUSIC_U=..."',
    );
  }
  const outFd = fs.openSync(dest, 'w');
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(srcFd, chunk, 0, chunk.length, null);
      if (!n) break;
      fs.writeSync(outFd, chunk, 0, n);
    }
  } finally {
    try {
      fs.closeSync(srcFd);
    } catch {}
    try {
      fs.closeSync(outFd);
    } catch {}
  }
}

/** DPAPI 解密：走 PowerShell 落文件，避免 stdio 管道在受限环境里失败 */
function dpapiDecrypt(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nj-dpapi-'));
  const inFile = path.join(dir, 'in.b64');
  const outFile = path.join(dir, 'out.b64');
  const errFile = path.join(dir, 'err.txt');
  fs.writeFileSync(inFile, Buffer.from(input).toString('base64'));
  const ps = [
    '$ErrorActionPreference="Stop";',
    'Add-Type -AssemblyName System.Security;',
    `$b=[Convert]::FromBase64String((Get-Content -Raw -LiteralPath '${inFile}'));`,
    `$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');`,
    `[IO.File]::WriteAllText('${outFile}', [Convert]::ToBase64String($u));`,
  ].join(' ');
  const shell = process.env.COMSPEC ? 'powershell.exe' : 'powershell';
  const ret = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 20000,
  });
  if (!fs.existsSync(outFile)) {
    const reason = ret.error ? ret.error.message : `powershell 退出码 ${ret.status}`;
    throw new Error(`DPAPI 解密失败（${reason}）。可改用 nj login --cookie "MUSIC_U=..." 手工登录。`);
  }
  return Buffer.from(fs.readFileSync(outFile, 'utf8').trim(), 'base64');
}

function loadChromiumKey(localStatePath) {
  if (!localStatePath || !fs.existsSync(localStatePath)) return null;
  const raw = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encrypted = raw?.os_crypt?.encrypted_key;
  if (!encrypted) return null;
  const buf = Buffer.from(encrypted, 'base64');
  if (buf.subarray(0, 5).toString() === 'DPAPI') return dpapiDecrypt(buf.subarray(5));
  return dpapiDecrypt(buf);
}

/** 解 Chromium 的 encrypted_value：v10/v11 是 AES-256-GCM，老格式整体 DPAPI */
function decryptChromiumValue(encBuf, key) {
  const buf = Buffer.from(encBuf);
  if (!buf.length) return '';
  const prefix = buf.subarray(0, 3).toString();
  if (prefix === 'v20') {
    throw new Error(
      'Chrome/Edge 127+ 的 App-Bound 加密（v20）无法离线解密。请用 nj login --cookie "MUSIC_U=..." 或 nj login --qr',
    );
  }
  if (prefix === 'v10' || prefix === 'v11') {
    if (!key) throw new Error('缺少 Local State 密钥，无法解密浏览器的 cookie');
    const nonce = buf.subarray(3, 15);
    const tag = buf.subarray(buf.length - 16);
    const data = buf.subarray(15, buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
  return dpapiDecrypt(buf).toString('utf8');
}

function loadSqlite() {
  // node:sqlite 在 22.x 会打 ExperimentalWarning，这里静音，避免污染 CLI 输出
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === 'string' ? warning : warning?.message || '';
    if (/SQLite/i.test(text)) return;
    return original.call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

function queryCookies(profile) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = loadSqlite());
  } catch {
    throw new Error('当前 Node 不带 node:sqlite（需要 Node >= 22.5）。可改用 nj login --cookie "MUSIC_U=..."');
  }
  const { file, dir } = copyDb(profile.db);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const isFirefox = profile.browser === 'firefox';
    const sql = isFirefox
      ? 'SELECT host, name, value FROM moz_cookies WHERE host LIKE ?'
      : 'SELECT host_key AS host, name, value, encrypted_value FROM cookies WHERE host_key LIKE ?';
    const stmt = db.prepare(sql);
    const found = new Map();
    for (const host of TARGET_HOSTS) {
      for (const row of stmt.all(`%${host}%`)) {
        if (found.has(row.name)) continue;
        found.set(row.name, row);
      }
    }
    return { rows: [...found.values()], isFirefox, dir };
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/**
 * 从本机浏览器读取 music.163.com 域的 cookie。
 * 返回 { cookie: "k=v; k2=v2", browser, profile, found: [...] }
 */
function readBrowserCookie({ browser = 'auto', profileName } = {}) {
  const profiles = chromiumProfiles().filter((p) => {
    if (browser && browser !== 'auto' && p.browser !== browser) return false;
    if (profileName && p.profile !== profileName) return false;
    return true;
  });
  if (!profiles.length) {
    throw new Error(`没找到浏览器 Cookie 库（可用 --browser chrome|edge|firefox，当前 ${browser}）`);
  }

  const errors = [];
  for (const profile of profiles) {
    try {
      const { rows, isFirefox } = queryCookies(profile);
      if (!rows.length) {
        errors.push(`${profile.browser}/${profile.profile}: 没有网易云相关 cookie（浏览器里没登录过？）`);
        continue;
      }
      const key = isFirefox ? null : loadChromiumKey(profile.localState);
      const pairs = new Map();
      for (const row of rows) {
        let value = row.value || '';
        if (!value && row.encrypted_value) {
          try {
            value = decryptChromiumValue(row.encrypted_value, key);
          } catch (err) {
            errors.push(`${profile.browser}/${profile.profile}/${row.name}: ${err.message}`);
            continue;
          }
        }
        if (!value) continue;
        pairs.set(row.name, value);
      }
      if (!pairs.has('MUSIC_U')) {
        errors.push(`${profile.browser}/${profile.profile}: 解出了 ${pairs.size} 个 cookie，但没有 MUSIC_U`);
        continue;
      }
      const keep = ['MUSIC_U', '__csrf', 'NMTID', 'MUSIC_A_T', 'MUSIC_R_T', 'MUSIC_SNS', 'MUSIC_A'];
      const cookie = [...pairs]
        .filter(([k]) => keep.includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      return { cookie, browser: profile.browser, profile: profile.profile, names: [...pairs.keys()] };
    } catch (err) {
      errors.push(`${profile.browser}/${profile.profile}: ${err.message}`);
    }
  }
  const err = new Error('没能从浏览器里取到登录态：\n  ' + errors.slice(0, 6).join('\n  '));
  err.details = errors;
  throw err;
}

module.exports = {
  readBrowserCookie,
  chromiumProfiles,
  decryptChromiumValue,
  loadChromiumKey,
  dpapiDecrypt,
  copyDb,
};
