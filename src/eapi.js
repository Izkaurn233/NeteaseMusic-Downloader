const crypto = require('crypto');

// eapi 的对称密钥是硬编码的（客户端内置），与 weapi 的 RSA 不同。
// 所有能拿到会员直链的实现都走 eapi：weapi 的 /song/enhance/player/url/v1 对
// VIP 曲目经常直接返回 url:null，而 eapi 带上 MUSIC_U 就会给真实地址。
const EAPI_KEY = Buffer.from('e82ckenh8dichen8');
const SEPARATOR = '-36cd479b6b5-';

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

// 明文结构：nobody<url>use<json>md5forencrypt 的 md5 作为签名，
// 再拼成 <url>-36cd479b6b5-<json>-36cd479b6b5-<digest>，AES-128-ECB 加密后转 hex。
function eapiParams(url, payload) {
  const text = JSON.stringify(payload);
  const message = `nobody${url}use${text}md5forencrypt`;
  const digest = md5(message);
  const data = `${url}${SEPARATOR}${text}${SEPARATOR}${digest}`;
  const cipher = crypto.createCipheriv('aes-128-ecb', EAPI_KEY, null);
  return Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]).toString('hex').toUpperCase();
}

function eapiDecrypt(params) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', EAPI_KEY, null);
  const raw = Buffer.concat([decipher.update(Buffer.from(String(params), 'hex')), decipher.final()]);
  const text = raw.toString('utf8');
  const parts = text.split(SEPARATOR);
  const body = parts[1] ?? text;
  return { text, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() };
}

module.exports = { eapiParams, eapiDecrypt, EAPI_KEY, SEPARATOR };
