'use strict';
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const messages = {
  unavailable: 'PPT 转 PDF 需要 Windows 和已安装的 Microsoft PowerPoint',
  invalid: '这不是有效的 PPT/PPTX 文件',
  failed: 'PowerPoint 转换失败，请确认文件未损坏、未加密，并已完成 Office 首次启动设置',
  timeout: 'PowerPoint 转换超时，请检查 Office 是否有待处理的提示后重试',
};
function failure(code, status = 422) { return Object.assign(new Error(messages[code]), { status }); }
let queueTail = Promise.resolve();
const jobs = new Map();
const validId = id => /^[a-zA-Z0-9-]{1,100}$/.test(id || '');
function conversionStatus(id) { return validId(id) ? jobs.get(id) || null : null; }

async function convertPowerPoint(body, name, taskId = '') {
  const ext = path.extname(name).toLowerCase();
  const magic = ext === '.pptx' ? Buffer.from([0x50, 0x4b, 3, 4]) : Buffer.from('d0cf11e0a1b11ae1', 'hex');
  if (!['.ppt', '.pptx'].includes(ext) || !body.subarray(0, magic.length).equals(magic)) throw failure('invalid', 400);
  if (process.platform !== 'win32') throw failure('unavailable', 503);
  const track = validId(taskId);
  if (track) jobs.set(taskId, 'waiting');
  const previous = queueTail;
  let release;
  queueTail = new Promise(resolve => { release = resolve; });
  await previous;
  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prt-ppt-'));
    const input = path.join(dir, `source${ext}`);
    const output = path.join(dir, 'converted.pdf');
    const statePath = path.join(dir, 'status.txt');
    await fs.writeFile(input, body);
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'desktop', 'tools', 'ppt-to-pdf.ps1'), '-InputPath', input, '-OutputPath', output, '-StatePath', statePath],
      { windowsHide: true, stdio: 'ignore' });
      let timedOut = false, closed = false;
      const launched = Date.now();
      let conversionStarted = 0, sawWorker = false, checking = false;
      const timer = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          const status = (await fs.readFile(statePath, 'utf8').catch(() => '')).trim();
          if (status) sawWorker = true;
          if (status === 'converting') {
            if (!conversionStarted) conversionStarted = Date.now();
            if (track && !closed) jobs.set(taskId, 'converting');
          }
          if (conversionStarted ? Date.now() - conversionStarted >= 120000 : !sawWorker && Date.now() - launched >= 15000) {
            timedOut = true; child.kill();
          }
        } finally { checking = false; }
      }, 200);
      child.once('error', () => { closed = true; clearInterval(timer); reject(failure('unavailable', 503)); });
      child.once('close', code => {
        closed = true; clearInterval(timer);
        if (timedOut) reject(failure('timeout', 504));
        else if (code === 0) resolve();
        else reject(failure(code === 2 ? 'unavailable' : 'failed', code === 2 ? 503 : 422));
      });
    });
    const stat = await fs.stat(output);
    if (stat.size > 256 * 1024 * 1024) throw failure('failed');
    const pdf = await fs.readFile(output);
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw failure('failed');
    return pdf;
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (track) jobs.delete(taskId);
    release();
  }
}
module.exports = { convertPowerPoint, conversionStatus };
