'use strict';
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const messages = {
  unavailable: 'PPT 转 PDF 需要 Windows 和已安装的 Microsoft PowerPoint',
  busy: '正在转换另一份 PPT，请稍后重试',
  invalid: '这不是有效的 PPT/PPTX 文件',
  failed: 'PowerPoint 转换失败，请确认文件未损坏、未加密，并已完成 Office 首次启动设置',
  timeout: 'PowerPoint 转换超时，请检查 Office 是否有待处理的提示后重试',
};
function failure(code, status = 422) { return Object.assign(new Error(messages[code]), { status }); }
let busy = false;

async function convertPowerPoint(body, name) {
  const ext = path.extname(name).toLowerCase();
  const magic = ext === '.pptx' ? Buffer.from([0x50, 0x4b, 3, 4]) : Buffer.from('d0cf11e0a1b11ae1', 'hex');
  if (!['.ppt', '.pptx'].includes(ext) || !body.subarray(0, magic.length).equals(magic)) throw failure('invalid', 400);
  if (process.platform !== 'win32') throw failure('unavailable', 503);
  if (busy) throw failure('busy', 409);
  busy = true;
  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prt-ppt-'));
    const input = path.join(dir, `source${ext}`);
    const output = path.join(dir, 'converted.pdf');
    await fs.writeFile(input, body);
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'desktop', 'tools', 'ppt-to-pdf.ps1'), '-InputPath', input, '-OutputPath', output],
      { windowsHide: true, stdio: 'ignore' });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
      child.once('error', () => { clearTimeout(timer); reject(failure('unavailable', 503)); });
      child.once('close', code => {
        clearTimeout(timer);
        if (timedOut) reject(failure('timeout', 504));
        else if (code === 0) resolve();
        else if (code === 3) reject(failure('busy', 409));
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
    busy = false;
  }
}
module.exports = { convertPowerPoint };
