#!/usr/bin/env node
const { startWeb } = require('../src/web');

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('端口必须是 0-65535 的整数。\n');
  process.exit(1);
}
startWeb({ port, open: !args.includes('--no-open') }).then(({ url, close }) => {
  process.stdout.write(`\n♫ Netease Music DownLoader\n\n  本机地址：${url}\n  浏览器可搜索、预览和选择音质下载。\n  按 Ctrl+C 停止服务。\n\n`);
  process.once('SIGINT', () => { close(); process.exit(0); });
  process.once('SIGTERM', () => { close(); process.exit(0); });
}).catch((err) => {
  process.stderr.write(`网页版启动失败：${err.message}\n`);
  process.exitCode = 1;
});
