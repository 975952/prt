/** Regression for Linux CI hanging after an otherwise successful HTTP test suite. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopChild } from './_exe.mjs';

async function liveChild(ignoreTerm = false) {
  const child = spawn(process.execPath, ['-e', `
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    setInterval(() => {}, 1000);
    process.stdout.write('ready\\n');
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout, 'data');
  return child;
}

// Every host uses its real cleanup path, targeting only the ChildProcess created here.
const child = await liveChild();
try {
  await stopChild(child, 1000);
  assert(child.exitCode !== null || child.signalCode !== null, 'actual child has exited');
  await stopChild(child, 1000);
} finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
console.log('PASS child cleanup terminates its real Node child and is safe to repeat');

if (process.platform !== 'win32') {
  const stubborn = await liveChild(true);
  try {
    await stopChild(stubborn, 100);
    assert.equal(stubborn.signalCode, 'SIGKILL', 'ignored SIGTERM escalates to SIGKILL');
  } finally { if (stubborn.exitCode === null && stubborn.signalCode === null) stubborn.kill('SIGKILL'); }
  console.log('PASS a real child ignoring SIGTERM is force-stopped within the cleanup deadline');
}

const signaled = await liveChild();
try {
  const exit = once(signaled, 'exit');
  signaled.kill('SIGTERM');
  await exit;
  assert.equal(signaled.exitCode, null);
  assert.equal(signaled.signalCode, 'SIGTERM');
  await stopChild(signaled, 100);
} finally { if (signaled.exitCode === null && signaled.signalCode === null) signaled.kill('SIGKILL'); }
await stopChild(null);
await stopChild({ pid: 42, exitCode: 0, signalCode: null, kill() { assert.fail('already exited'); } });
console.log('PASS numeric and signal exit states are handled without retargeting exited children');
