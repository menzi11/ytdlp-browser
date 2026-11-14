// 不依赖浏览器，直接按 Chromium native messaging 的帧协议跟宿主对话。
// 用法：node tools/test-host.js [mode] [url]
//   mode: best | cap1080 | audio-mp3 | audio-m4a | subs
const { spawn } = require('child_process');
const path = require('path');

const mode = process.argv[2] || 'best';
const url = process.argv[3] || 'https://www.w3schools.com/html/mov_bbb.mp4';

const exe = path.resolve(__dirname, '..', 'host', 'ytdlp-host.exe');
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });

let inbox = Buffer.alloc(0);
const handlers = [];

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  child.stdin.write(head);
  child.stdin.write(body);
}

child.stdout.on('data', (chunk) => {
  inbox = Buffer.concat([inbox, chunk]);
  for (;;) {
    if (inbox.length < 4) return;
    const len = inbox.readUInt32LE(0);
    if (inbox.length < 4 + len) return;
    const msg = JSON.parse(inbox.subarray(4, 4 + len).toString('utf8'));
    inbox = inbox.subarray(4 + len);
    const h = handlers.shift();
    if (h) h(msg);
  }
});

const next = () => new Promise((resolve) => handlers.push(resolve));

const timeout = setTimeout(() => { console.log('TIMEOUT'); child.kill(); process.exit(1); }, 240000);

(async () => {
  send({ action: 'ping' });
  console.log('PING  ->', JSON.stringify(await next()));

  send({ action: 'download', url, mode, subs: true, playlist: false });
  let lastLog = '';
  for (;;) {
    const msg = await next();
    if (msg.type === 'tick') continue;
    if (msg.type === 'progress') {
      const pct = msg.total ? ((msg.downloaded / msg.total) * 100).toFixed(0) + '%' : '?';
      process.stdout.write(`\rPROG  -> ${pct}   `);
      continue;
    }
    if (msg.type === 'log') { lastLog = msg.line; continue; }
    console.log('\n' + msg.type.toUpperCase().padEnd(5) + ' ->', JSON.stringify(msg));
    if (msg.type === 'done' || msg.type === 'error') break;
  }
  if (lastLog) console.log('last log:', lastLog.slice(0, 200));

  clearTimeout(timeout);
  child.stdin.end();
  setTimeout(() => process.exit(0), 300);
})();
