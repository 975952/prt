import assert from 'node:assert/strict';
import { validateTargetFolder } from '../public/js/paper-organizer.js';
for (const folder of ['数学/线性代数', 'Computer science/Vision', '新文件夹', 'papers.2026/topic']) assert.equal(validateTargetFolder(folder).valid, true, folder);
assert.deepEqual(validateTargetFolder('数学\\线性代数'), { valid: true, folder: '数学/线性代数', error: '' });
for (const folder of ['', ' ', '.', '..', '.hidden', 'a/.hidden', '/absolute', '\\absolute', 'C:\\papers', 'C:papers', '//server/share', 'a/../b', 'a/./b', 'a//b', 'a/', 'a/NUL', 'a/COM1.txt', 'a/LPT²', 'CON', 'name.', 'name ', ' name', 'a/<b>', 'a:b', 'a\u0000b', 'a\u0085b', 'a?b', 'a*b', 'a|b', 'a'.repeat(256), Array(5).fill('a'.repeat(200)).join('/')]) {
  assert.equal(validateTargetFolder(folder).valid, false, JSON.stringify(folder));
}
assert.equal(validateTargetFolder('CONference').valid, true, 'ordinary words beginning with a device name remain valid');
assert.equal(validateTargetFolder('a'.repeat(255)).valid, true, 'folder segment limit matches the move API');
console.log('PASS safe relative destination paths, Windows reserved names and path limits');
