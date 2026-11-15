const crypto = require('crypto');

const IV = Buffer.from('0102030405060708');
const PRESET_KEY = Buffer.from('0CoJUm6Qyw8W8jud');
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

function aesEncrypt(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]).toString('base64');
}

function rsaEncrypt(text) {
  const buf = Buffer.alloc(128);
  Buffer.from(text, 'utf8').copy(buf, 128 - 16);
  return crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, buf).toString('hex');
}

function randomKey(len = 16) {
  let out = '';
  for (let i = 0; i < len; i++) out += BASE62[Math.floor(Math.random() * BASE62.length)];
  return out;
}

function weapi(payload) {
  const text = JSON.stringify(payload);
  const secretKey = randomKey();
  return {
    params: aesEncrypt(aesEncrypt(text, PRESET_KEY), Buffer.from(secretKey)),
    encSecKey: rsaEncrypt(secretKey.split('').reverse().join('')),
  };
}

module.exports = { weapi, randomKey };
