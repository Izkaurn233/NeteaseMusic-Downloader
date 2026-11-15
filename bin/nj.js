#!/usr/bin/env node
const { main } = require('../src/cli');

main(process.argv.slice(2)).catch((err) => {
  const msg = err.message || String(err);
  process.stderr.write(`\x1b[31m错误:\x1b[0m ${msg}\n`);
  if (/-46[02]/.test(msg)) {
    process.stderr.write(
      '\x1b[90m  -462 / -460 是网易接口风控（要人机验证或判定网络环境异常），不是命令写错。\n' +
        '  可以先登录（nj login --browser chrome / --qr / --cookie），或换手机热点再试。\x1b[0m\n',
    );
  }
  if (process.env.DEBUG) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
