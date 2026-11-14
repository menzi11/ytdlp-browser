// 从浏览器配置里找出已加载扩展的实际 ID（CentBrowser 忽略 manifest.key，ID 由它自己派生）
const fs = require('fs');
const path = require('path');

const base = path.join(process.env.LOCALAPPDATA, 'CentBrowser', 'User Data');
const files = ['Default/Preferences', 'Default/Secure Preferences', 'Local State'];

for (const rel of files) {
  const p = path.join(base, rel);
  if (!fs.existsSync(p)) { console.log(`(跳过) ${rel}`); continue; }
  let json;
  try { json = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.log(`(解析失败) ${rel}: ${e.message}`); continue; }
  const settings = (json.extensions && json.extensions.settings) || {};
  const rows = Object.entries(settings)
    .map(([id, v]) => ({ id, name: v.manifest && v.manifest.name, path: v.path, state: v.state, location: v.location }))
    .filter((r) => r.name && /yt-dlp|下载器/i.test(r.name));
  if (rows.length) {
    console.log(`--- ${rel} ---`);
    rows.forEach((r) => console.log(JSON.stringify(r, null, 0)));
  }
}
