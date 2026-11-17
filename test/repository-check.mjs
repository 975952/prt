/** Keep visitor-facing documentation links and publishing boundaries intact. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const docs = ['README.md', 'README.en.md', 'docs/quick-start.en.md', 'docs/internationalization.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'docs/README.md', 'docs/使用说明书.md', 'docs/开发指南.md', 'docs/第三方组件.md',
  'docs/多窗口阅读.md', 'docs/prompts.md', 'docs/assets/README.md', 'desktop/README.md'];
const inGit = fs.existsSync(path.join(root, '.git'));
const files = inGit
  ? execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean) : [];
const tracked = new Set(files);
const publicDoc = file => docs.includes(file) || /^docs\/(?:assets|licenses)\//.test(file);
let links = 0;
for (const file of docs) {
  if (inGit) assert.ok(tracked.has(file), `${file}: documentation must be tracked`);
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = decodeURIComponent(match[1].split('#')[0]);
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const resolved = path.resolve(root, path.dirname(file), target);
    assert.ok(fs.existsSync(resolved), `${file}: broken local link ${target}`);
    if (inGit) {
      const relative = path.relative(root, resolved).split(path.sep).join('/');
      assert.ok(tracked.has(relative) || files.some(name => name.startsWith(`${relative}/`)),
        `${file}: link points to an untracked local file ${target}`);
    }
    links++;
  }
}
const forbidden = /^(?:AGENTS\.md$|design\/|data\/|papers\/|docs\/internal\/|tools\/internal\/|archive\/|desktop\/target\/|test\/artifacts\/)|(?:^|\/)(?:node_modules\/|\.env(?:\.|$))|\.(?:exe|apk)$/i;
assert.deepEqual(files.filter(file => forbidden.test(file)), [], 'private data and binaries must remain outside Git');
assert.deepEqual(files.filter(file => file.startsWith('docs/') && !publicDoc(file)), [],
  'public documentation must be listed in the documentation index and source package');
assert.ok(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').startsWith('MIT License\n'));
console.log(`PASS ${links} local documentation links; tracked paths exclude private data and binaries`);
