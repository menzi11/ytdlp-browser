// 静态自检：manifest 合法、key 与固定扩展 ID 一致（不一致浏览器会拒绝连宿主）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.resolve(__dirname, '..', 'extension');
let failed = 0;
const ok = (msg) => console.log('  OK   ' + msg);
const bad = (msg) => { failed++; console.log('  FAIL ' + msg); };

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
ok('manifest.json 可解析，name=' + manifest.name + ' mv' + manifest.manifest_version);

const der = Buffer.from(manifest.key, 'base64');
const sha = crypto.createHash('sha256').update(der).digest();
const id = [...sha.subarray(0, 16).toString('hex')]
  .map((c) => String.fromCharCode(c.charCodeAt(0) <= '9'.charCodeAt(0) ? c.charCodeAt(0) + 49 : c.charCodeAt(0) + 15))
  .join('');
const pinned = fs.readFileSync(path.resolve(__dirname, 'extension-id.txt'), 'ascii').trim();
id === pinned ? ok('扩展 ID 与 manifest.key 一致: ' + id) : bad('扩展 ID 不一致: ' + id + ' != ' + pinned);

const hostManifestPath = path.resolve(__dirname, '..', 'host', 'manifest.json');
const hostManifest = JSON.parse(fs.readFileSync(hostManifestPath, 'utf8'));
const expectOrigin = 'chrome-extension://' + pinned + '/';
hostManifest.allowed_origins.includes(expectOrigin)
  ? ok('宿主 allowed_origins 含 ' + expectOrigin)
  : bad('宿主 allowed_origins 不匹配: ' + hostManifest.allowed_origins.join(','));
fs.existsSync(hostManifest.path) ? ok('宿主 exe 存在: ' + hostManifest.path) : bad('宿主 exe 不存在: ' + hostManifest.path);

for (const f of ['background.js', 'popup.js', 'popup.html', 'popup.css', 'icons/icon128.png']) {
  fs.existsSync(path.join(dir, f)) ? ok('存在 ' + f) : bad('缺少 ' + f);
}

// 扩展里引用到的权限是否都在 manifest 里声明
const bg = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
for (const need of ['nativeMessaging', 'cookies', 'contextMenus', 'storage', 'notifications']) {
  manifest.permissions.includes(need) ? ok('声明权限 ' + need) : bad('缺少权限 ' + need);
}
bg.includes('com.mengke.ytdlp') ? ok('background.js 使用 com.mengke.ytdlp') : bad('background.js 宿主名不一致');

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
