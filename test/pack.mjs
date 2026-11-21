import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const STAGE = path.join(import.meta.dirname, 'artifacts', 'pkg');
const STAGE_ROOT = path.join(import.meta.dirname, 'artifacts');
const ZIP = path.join(import.meta.dirname, 'artifacts', 'prt-src.zip');
const VERIFY = path.join(STAGE_ROOT, 'pkg-verify');
// Every cleanup target is fixed under the isolated packaging directory.
for (const target of [STAGE, ZIP, VERIFY]) {
  if (!path.resolve(target).startsWith(`${path.resolve(STAGE_ROOT)}${path.sep}`)) {
    throw new Error(`Refusing packaging cleanup outside ${path.resolve(STAGE_ROOT)}`);
  }
}

/** 要发布的顶层文件 / 目录（相对 ROOT） */
const INCLUDE = [
  'server.js',
  'security.js',
  'model-profiles.js',
  'powerpoint.js',
  'start.bat',
  'README.md',
  'README.en.md',
  'LICENSE',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '.github',
  '.gitignore',
  '.gitattributes',
  'public',
  'desktop/src',
  'desktop/assets/book-spine.ico',
  'desktop/assets/book-spine.rgba',
  'desktop/Cargo.toml',
  'desktop/Cargo.lock',
  'desktop/README.md',
  'desktop/build.bat',
  'desktop/build-setup.ps1',
  'desktop/installer',
  'desktop/build.rs',
  'desktop/tools',
  'docs/README.md',
  'docs/使用说明书.md',
  'docs/开发指南.md',
  'docs/多窗口阅读.md',
  'docs/Alina与会话体系.md',
  'docs/第三方组件.md',
  'docs/internationalization.md',
  'docs/quick-start.en.md',
  'docs/prompts.md',
  'docs/assets',
  'docs/licenses',
  'test',
];

/** 兜底：就算误入白名单，这些也绝不进包 */
const DENY = [
  /(^|[\\/])data([\\/]|$)/,
  /(^|[\\/])papers([\\/]|$)/,
  /node_modules/,
  /[\\/]target[\\/]/,
  /[\\/]artifacts[\\/]/,
  /(^|[\\/])dist([\\/]|$)/i,
  /\.(exe|dll|msi|msix|msixbundle|appx|zip|pfx|p12|key)$/i,
  /\.pdf$/i,        // 例外只有下面 isFixturePdf() 放行的合成夹具
  /\.log$/i,
  /webview2/,
  /\.desktop-port$/,
  /(^|[\\/])internal([\\/]|$)/,
  /^(?:AGENTS\.md$|design[\\/]|docs[\\/]archive[\\/]|docs[\\/]PROGRESS\.md$)/,
  /^(?:archive|test[\\/]archive)([\\/]|$)/,
  /(^|[\\/])\.env(?:\.|$)/,
  /(^|[\\/])profile-[^\\/]*([\\/]|$)/,
  /(^|[\\/])dump([\\/]|$)/,
];

const isFixturePdf = (rel) => /^test[\\/]fixtures[\\/][^\\/]+\.pdf$/i.test(rel);

const walk = (abs, rel, out) => {
  // Reject whole private/build directories before walking them.
  if (DENY.some((re) => re.test(rel)) && !isFixturePdf(rel)) return;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(abs)) walk(path.join(abs, e), path.join(rel, e), out);
    return;
  }
  out.push({ abs, rel });
};

/* ── 1. 收集 ── */
const files = [];
for (const item of INCLUDE) {
  const abs = path.join(ROOT, item);
  if (!fs.existsSync(abs)) { console.log(`  [skip] 不存在：${item}`); continue; }
  walk(abs, item, files);
}

/* ── 2. 安全检查：包里绝不能出现密钥 / 论文 ── */
const dangerous = files.filter((f) => /(^|[\\/])data([\\/]|$)|(^|[\\/])papers([\\/]|$)|\.exe$/i.test(f.rel)
  || (/\.pdf$/i.test(f.rel) && !isFixturePdf(f.rel)));
if (dangerous.length) {
  console.error('拒绝打包：白名单里混进了敏感文件');
  for (const d of dangerous) console.error('  ' + d.rel);
  process.exit(1);
}
// 反向自检：敏感目录一个都不许出现在清单里（正常情况 DENY 已经拦掉了，这里是第二道）
const forbidden = files.filter((f) => /(^|[\\/])(data|papers|node_modules|artifacts|dist)([\\/]|$)/i.test(f.rel)
  || /[\\/]target[\\/]/i.test(f.rel));
if (forbidden.length) {
  console.error('拒绝打包：清单里出现了 data/ papers/ artifacts/ dist/ node_modules/ target/');
  for (const f of forbidden) console.error('  ' + f.rel);
  process.exit(1);
}
const leaked = [];
for (const f of files) {
  if (!/\.(js|mjs|json|html|css|md|rs|toml|bat|ps1|iss|flag|txt|ya?ml)$/i.test(f.rel)) continue;
  const txt = fs.readFileSync(f.abs, 'utf8');
  // 真实 API Key 长这样：sk- 后面 30+ 位
  if (/sk-[A-Za-z0-9]{20,}/.test(txt)) leaked.push(f.rel);
}
if (leaked.length) {
  console.error('拒绝打包：这些文件里出现了疑似真实 API Key');
  for (const l of leaked) console.error('  ' + l);
  process.exit(1);
}

/* ── 2.5 检查必需前端文件 ── */
const REQUIRED_PUBLIC = [
  'public/js/prompts/index.js',
  'public/js/prompts/registry.js',
  'public/js/prompts/compose.js',
  'public/js/prompts/capabilities/qa.js',
  'public/js/prompts/capabilities/teach.js',
  'public/js/app.js',
  'public/js/app-updates.js',
  'public/js/folder-import.js',
  'public/js/glass-material.js',
  'public/js/i18n.js',
  'public/js/locales/en.js',
  'public/js/ai.js',
  'public/js/teaching.js',
  'public/js/tabs.js',
  'public/tabs.css',
  'desktop/build-setup.ps1',
  'desktop/installer/prt.iss',
  'desktop/installer/prt-installed.flag',
  '.github/workflows/release.yml',
];
const missingPublic = REQUIRED_PUBLIC.filter((rel) => !files.some((f) => f.rel.replace(/\\/g, '/') === rel));
if (missingPublic.length) {
  console.error('拒绝打包：源码包里缺少必需的前端文件（白名单/目录遍历有问题）');
  for (const f of missingPublic) console.error('  ' + f);
  process.exit(1);
}
console.log(`前端白名单抽查：通过（${REQUIRED_PUBLIC.length} 个关键文件都在包里）`);

/* ── 3. 落到临时目录 ── */
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
let bytes = 0;
for (const f of files) {
  const dst = path.join(STAGE, f.rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(f.abs, dst);
  bytes += fs.statSync(dst).size;
}

/* ── 4. 打 zip ── */
fs.rmSync(ZIP, { force: true });
// Windows tar versions differ in their handling of Unicode ZIP entry names.
// Use .NET with explicit UTF-8 names and '/' separators, including dotfiles.
// Paths travel through the environment, never through executable script text.
const archiveEnv = { ...process.env, PRT_PACKAGE_STAGE: STAGE, PRT_PACKAGE_ZIP: ZIP, PRT_PACKAGE_VERIFY: VERIFY };
const runArchiveScript = script => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
  $ErrorActionPreference = 'Stop'
  [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression')
  [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
  ${script}
`], { stdio: 'inherit', env: archiveEnv });
const zipTool = process.platform === 'win32' ? '.NET ZIP (UTF-8)' : 'zip';
if (process.platform === 'win32') {
  runArchiveScript(`
    $stageRoot = [IO.Path]::GetFullPath($env:PRT_PACKAGE_STAGE).TrimEnd([char]92) + [char]92
    $archive = [IO.Compression.ZipFile]::Open($env:PRT_PACKAGE_ZIP, [IO.Compression.ZipArchiveMode]::Create, [Text.Encoding]::UTF8)
    try {
      foreach ($sourceFile in [IO.Directory]::EnumerateFiles($stageRoot, '*', [IO.SearchOption]::AllDirectories)) {
        $entryName = $sourceFile.Substring($stageRoot.Length).Replace([char]92, [char]47)
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $sourceFile, $entryName, [IO.Compression.CompressionLevel]::Optimal)
      }
    } finally { $archive.Dispose() }
  `);
} else {
  execFileSync('zip', ['-q', '-r', ZIP, '.'], { cwd: STAGE, stdio: 'inherit' });
}
fs.rmSync(STAGE, { recursive: true, force: true });

let verifyNote = '';
try {
  fs.rmSync(VERIFY, { recursive: true, force: true });
  fs.mkdirSync(VERIFY, { recursive: true });
  if (process.platform === 'win32') {
    runArchiveScript('[IO.Compression.ZipFile]::ExtractToDirectory($env:PRT_PACKAGE_ZIP, $env:PRT_PACKAGE_VERIFY, [Text.Encoding]::UTF8)');
  } else {
    execFileSync('unzip', ['-q', ZIP, '-d', VERIFY], { stdio: 'inherit' });
  }
  execFileSync(process.execPath, [path.join(VERIFY, 'test', 'repository-check.mjs')], { stdio: 'inherit' });
  const dataDir = path.join(VERIFY, '__data__');
  const papersDir = path.join(VERIFY, 'test', 'fixtures');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 8999;
  const child = spawn(process.execPath, [path.join(VERIFY, 'server.js')], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0' },
  });
  let health = null;
  for (let i = 0; i < 40 && !health; i++) {
    await new Promise((r) => setTimeout(r, 250));
    health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  const papers = health ? await fetch(`http://127.0.0.1:${port}/api/papers`).then((r) => r.json()).catch(() => null) : null;
  child.kill();
  if (!health?.ok) throw new Error('解包后的服务没起来');
  if (!(papers?.papers || []).length) throw new Error('解包后的服务读不到夹具 PDF');
  verifyNote = `通过（起得来、/api/health ok、读到 ${papers.papers.length} 个夹具 PDF）`;
} catch (e) {
  verifyNote = `**失败**：${e.message}`;
  console.error('\n拒绝交付：源码包解开后跑不起来 —— 白名单很可能漏了 server.js 依赖的模块');
  console.error('  ' + e.message);
  fs.rmSync(VERIFY, { recursive: true, force: true });
  process.exit(1);
} finally {
  fs.rmSync(VERIFY, { recursive: true, force: true });
}

const zipSize = fs.statSync(ZIP).size;
console.log(`\n文件数：${files.length}`);
console.log(`原始大小：${(bytes / 1048576).toFixed(1)} MB`);
console.log(`压缩后：${(zipSize / 1048576).toFixed(1)} MB`);
console.log(`打包器：${zipTool}`);
console.log(`输出：${ZIP}`);
console.log(`解包自检：${verifyNote}`);
console.log('\n前 20 个文件：');
for (const f of files.slice(0, 20)) console.log('  ' + f.rel);
// 夹具 PDF 单独列出来：它们进了包，e2e / ux / cjk 这些套件才跑得起来，值得一眼核对
const fixturePdfs = files.filter((f) => isFixturePdf(f.rel)).map((f) => f.rel).sort();
console.log(`\n合成 PDF 夹具（${fixturePdfs.length} 个）：`);
for (const f of fixturePdfs) console.log('  ' + f);
console.log(`敏感路径自检：${forbidden.length === 0 ? '通过（清单里没有 data/ / papers/ / artifacts/ / dist/ / node_modules/ / target/）' : '失败'}`);
