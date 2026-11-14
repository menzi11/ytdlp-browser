// 生成一个固定扩展 ID 所需的公钥：
// Chromium 的扩展 ID = sha256(SubjectPublicKeyInfo DER) 前 16 字节，每个 nibble 映射 0-f -> a-p
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const sha = crypto.createHash('sha256').update(publicKey).digest();
const id = [...sha.subarray(0, 16).toString('hex')]
  .map((c) => String.fromCharCode(c.charCodeAt(0) <= '9'.charCodeAt(0) ? c.charCodeAt(0) + 49 : c.charCodeAt(0) + 15))
  .join('');

fs.writeFileSync(path.join(root, 'extension', 'key.txt'), publicKey.toString('base64'), 'ascii');
fs.writeFileSync(path.join(root, 'tools', 'extension-id.txt'), id, 'ascii');
console.log('extension id :', id);
console.log('key bytes    :', publicKey.length);
