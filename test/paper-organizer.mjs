import assert from 'node:assert/strict';
import { classifyPaper, validateTargetFolder } from '../public/js/paper-organizer.js';

const cases = [
  ['Numerical Analysis - finite element method.pdf', '数学/数值分析'],
  ['Lecture_01-Ax=b.pdf', '数学/线性代数'],
  ['Matrix computation.pdf', '数学/线性代数'],
  ['概率论与数理统计.pdf', '数学/概率统计'],
  ['Tokens-to-Token ViT: Training Vision Transformers from Scratch', '计算机/计算机视觉'],
  ['DETR: End-to-End Object Detection with Transformers', '计算机/计算机视觉'],
  ['Attention Is All You Need', '计算机/自然语言处理'],
  ['Deep Reinforcement Learning', '计算机/深度学习'],
  ['运算放大器应用实验', '物理/电子与电路'],
  ['偏振与光学', '物理/物理学'],
  ['Complex Analysis', '数学/数学分析'],
];
for (const [title, folder] of cases) assert.equal(classifyPaper({ title }).folder, folder, title);
for (const name of ['1706.03762.pdf', 'lecture01.pdf', 'research-notes.pdf', 'unknown.pdf']) {
  const proposal = classifyPaper({ name });
  assert.equal(proposal.folder, '', `${name} needs manual confirmation`);
  assert.deepEqual(proposal.keywords, []);
}
assert.equal(classifyPaper({ name: '123.pdf', label: '123 · Deep Residual Learning for Image Recognition' }).folder, '计算机/计算机视觉');
assert.equal(classifyPaper({ name: 'file.pdf', title: 'Numerical Methods for Matrix Equations' }).folder, '数学/数值分析', 'specific topic wins over general matrix keyword');
for (const folder of ['数学/线性代数', 'Computer science/Vision', '新文件夹', 'papers.2026/topic']) assert.equal(validateTargetFolder(folder).valid, true, folder);
assert.deepEqual(validateTargetFolder('数学\\线性代数'), { valid: true, folder: '数学/线性代数', error: '' });
for (const folder of ['', ' ', '.', '..', '.hidden', 'a/.hidden', '/absolute', '\\absolute', 'C:\\papers', 'C:papers', '//server/share', 'a/../b', 'a/./b', 'a//b', 'a/', 'a/NUL', 'a/COM1.txt', 'a/LPT²', 'CON', 'name.', 'name ', ' name', 'a/<b>', 'a:b', 'a\u0000b', 'a\u0085b', 'a?b', 'a*b', 'a|b', 'a'.repeat(256), Array(5).fill('a'.repeat(200)).join('/')]) {
  assert.equal(validateTargetFolder(folder).valid, false, JSON.stringify(folder));
}
assert.equal(validateTargetFolder('CONference').valid, true, 'ordinary words beginning with a device name remain valid');
assert.equal(validateTargetFolder('a'.repeat(255)).valid, true, 'folder segment limit matches the move API');
console.log('PASS local topic proposals, conservative unknowns, specificity and safe folder paths');
