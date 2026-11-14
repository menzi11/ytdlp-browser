// 把固定扩展 ID 的公钥注入 manifest.template.json，生成 manifest.json。
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', 'extension');
const key = fs.readFileSync(path.join(dir, 'key.txt'), 'ascii').trim();
const tpl = fs.readFileSync(path.join(dir, 'manifest.template.json'), 'utf8');
if (!key) throw new Error('key.txt 为空');
fs.writeFileSync(path.join(dir, 'manifest.json'), tpl.replace('__KEY__', key), 'utf8');
console.log('manifest.json written, key length =', key.length);
