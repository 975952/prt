import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { SessionMemoryManager } from '../public/js/session-memory.js';
import { runWithDeadline } from '../public/js/task-deadline.js';

// Run the actual app helpers with controlled network timing and a small DOM-free
// host. These races must be exercised independently of network/server speed.
const appSource = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
function sourceBetween(start, end) {
  const from = appSource.indexOf(start), to = appSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing app helper boundary: ${start}`);
  return appSource.slice(from, to);
}
const helperSource = [
  sourceBetween('function matchesDeletedConversation(', 'async function sessionWriteRequest('),
  sourceBetween('function sessionMemoryKey(', 'function renderSessionBar('),
  sourceBetween('function onRemoteSessionSaved(', 'async function applyRemoteSessionSaved('),
].join('\n');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (status = 200, body = {}) => ({ status, ok: status < 400, json: async () => body });
const memory = id => ({ id, content: id, category: 'note', createdAt: 1, updatedAt: 1 });

function harness() {
  const saved = [], refreshed = [], statuses = [], retiredActive = [];
  const context = {
    AbortController, URLSearchParams, runWithDeadline, clearTimeout,
    sessionMemory: new SessionMemoryManager(),
    sessionMemoryWriteChains: new Map(), sessionMemoryOwners: new Map(),
    sessionMemoryVersions: new Map(), deletedSessionMemoryKeys: new Set(),
    sessionMemoryPanel: {
      currentSid: null,
      setSession(key) { this.currentSid = key; },
      setSaveState(key, status) { statuses.push([key, status]); },
      render() {},
    },
    scopeDocIdOf: value => value === '__global__' ? 'default' : value,
    chatOwnerKey: (scope, sid) => JSON.stringify([scope, sid || '']),
    hasChatScope: () => false,
    sessionScopeKey: () => 'default', activeSidFor: () => '',
    displayedChatKey: '', chatJobs: new Map(), chatViews: new Map(), docViews: new Map(),
    deletedChatKeys: new Set(), sessionWrites: { invalidate() {} },
    readActiveSessions: () => ({}), activeSessionSlot: () => 'global',
    activeSessionFallback: new Map(), historySessionOwners: new Map(),
    releaseRetiredChatPdfs() {}, persistSession: { cancel() {} }, clearChatBlock() {},
    refreshChatJobState() {}, toast() {}, tr: value => value,
    state: { doc: null, sessionEntries: [], history: [] },
    newSession: async () => { retiredActive.push(true); },
    notifySessionSaved: detail => saved.push(detail),
    refreshSavedConversationList: (...args) => refreshed.push(args),
    windowId: 'local-window', fetch: async () => response(),
  };
  const methods = vm.runInNewContext(helperSource + '\n({ retireDeletedConversation, retireSessionMemories, '
    + 'flushSessionMemoryWrite, flushSessionMemoryWrites, loadSessionMemories, setSessionMemoryContext, '
    + 'onRemoteSessionSaved, sessionMemoryKey });', context);
  function enqueue(scope, sid, items = [memory('new')]) {
    const key = methods.sessionMemoryKey(scope, sid);
    const owner = { scope, sid, docId: '' };
    const queue = { owner, pending: items.map(item => ({ action: 'add', memory: item })), task: null };
    context.sessionMemoryOwners.set(key, owner);
    context.sessionMemoryWriteChains.set(key, queue);
    context.sessionMemory.import(key, items);
    context.sessionMemoryVersions.set(key, 1);
    return { key, queue };
  }
  return { context, methods, enqueue, saved, refreshed, statuses, retiredActive };
}

// A deleted SID terminates its request and pending operations in every scope.
// An unrelated legacy conversation remains writable and cannot block close/save.
{
  const h = harness(), started = deferred(), late = deferred();
  const a = h.enqueue('paper-A', 'shared-sid', [memory('one'), memory('two')]);
  const b = h.enqueue('paper-B', '');
  h.context.sessionMemoryPanel.currentSid = a.key;
  let signal;
  h.context.fetch = async (url, options) => {
    if (new URLSearchParams(url.split('?')[1]).get('sid') === 'shared-sid') {
      signal = options.signal; started.resolve();
      return late.promise; // Simulate a provider that ignores abort.
    }
    return response();
  };
  const writing = h.methods.flushSessionMemoryWrite(a.key);
  await started.promise;
  h.methods.retireDeletedConversation('another-paper', 'shared-sid', { copies: true, announce: false });
  await writing;
  assert.equal(signal.aborted, true);
  assert.equal(a.queue.pending.length, 0);
  assert.equal(h.context.sessionMemoryWriteChains.has(a.key), false);
  assert.equal(h.context.sessionMemoryOwners.has(a.key), false);
  assert.equal(h.context.sessionMemory.getMemories(a.key).length, 0);
  assert.equal(h.context.sessionMemoryPanel.currentSid, null);
  h.methods.loadSessionMemories('paper-A', 'shared-sid', [memory('stale')]);
  assert.equal(h.context.sessionMemory.getMemories(a.key).length, 0);
  await h.methods.flushSessionMemoryWrites();
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].sid, '');
  assert.equal(h.context.sessionMemory.getMemories(b.key).length, 1);
  late.resolve(response());
  await tick();
  assert.equal(h.saved.length, 1);
  assert.equal(h.statuses.some(([key, status]) => key === a.key && status === 'error'), false);
}

// Blank SIDs are isolated by canonical scope, including global aliases.
{
  const h = harness(), a = h.enqueue('default', ''), b = h.enqueue('paper-B', '');
  h.methods.retireSessionMemories('__global__', '');
  assert.equal(h.context.sessionMemoryWriteChains.has(a.key), false);
  assert.equal(h.context.sessionMemoryWriteChains.get(b.key), b.queue);
  await h.methods.flushSessionMemoryWrites();
  assert.equal(h.saved[0].scope, 'paper-B');
}

// A tombstone is terminal, not a failed save that stays in the retry queue.
// The existing conversation retirement path also advances the active session.
{
  const h = harness(), a = h.enqueue('default', 'gone');
  h.context.hasChatScope = () => true;
  h.context.activeSidFor = () => 'gone';
  h.context.fetch = async () => response(409, { code: 'SESSION_DELETED' });
  await h.methods.flushSessionMemoryWrite(a.key);
  await h.methods.flushSessionMemoryWrites();
  assert.equal(h.context.sessionMemoryWriteChains.size, 0);
  assert.equal(h.context.deletedSessionMemoryKeys.has(a.key), true);
  assert.equal(h.retiredActive.length, 1);
  assert.equal(h.saved.length, 0);
  assert.equal(h.statuses.some(([, status]) => status === 'error'), false);
  h.methods.setSessionMemoryContext();
  assert.equal(h.context.sessionMemoryPanel.currentSid, null);
}

// A settled old task cannot remove or set the status of a replacement queue.
{
  const h = harness(), started = deferred(), late = deferred();
  const a = h.enqueue('default', 'old-task');
  h.context.fetch = async () => { started.resolve(); return late.promise; };
  const writing = h.methods.flushSessionMemoryWrite(a.key);
  await started.promise;
  h.methods.retireSessionMemories('default', 'old-task');
  const replacement = { owner: a.queue.owner, pending: [], task: null };
  h.context.sessionMemoryWriteChains.set(a.key, replacement);
  await writing;
  assert.equal(h.context.sessionMemoryWriteChains.get(a.key), replacement);
  assert.equal(h.statuses.at(-1)[1], '');
  late.resolve(response());
}

// A remote read starts while PATCH is in flight and returns stale data after
// PATCH drained the queue. The ACK revision must keep the new local memory.
{
  const h = harness(), started = deferred(), patch = deferred(), read = deferred();
  const a = h.enqueue('default', 'read-race');
  h.context.fetch = async (url, options) => {
    if (options?.method === 'PATCH') { started.resolve(); return patch.promise; }
    return read.promise;
  };
  const writing = h.methods.flushSessionMemoryWrite(a.key);
  await started.promise;
  h.methods.onRemoteSessionSaved({ kind: 'memory', scope: 'default', sid: 'read-race', sender: 'remote-window' });
  patch.resolve(response());
  await writing;
  read.resolve(response(200, { memories: [memory('stale')] }));
  await tick();
  assert.equal(h.context.sessionMemory.getMemories(a.key)[0].id, 'new');
  assert.equal(h.context.sessionMemoryVersions.get(a.key), 2);
}

// Genuine temporary failures keep the operation available for an explicit retry.
{
  const h = harness(), a = h.enqueue('default', 'retry');
  h.context.fetch = async () => response(503);
  await assert.rejects(h.methods.flushSessionMemoryWrite(a.key), /HTTP 503/);
  assert.equal(a.queue.pending.length, 1);
  assert.equal(h.statuses.at(-1)[1], 'error');
  h.context.fetch = async () => response();
  await h.methods.flushSessionMemoryWrite(a.key);
  assert.equal(h.context.sessionMemoryWriteChains.size, 0);
  assert.equal(h.statuses.at(-1)[1], 'saved');
}

// A committed move retires the source SID and opens the server's fresh target
// SID. The target's copied memories and subsequent edits remain available.
{
  const h = harness(), from = h.enqueue('paper-A', 'before-move');
  const copied = [...h.context.sessionMemory.getMemories(from.key)];
  h.methods.retireSessionMemories('paper-A', 'before-move');
  h.context.sessionScopeKey = () => 'default';
  h.context.activeSidFor = () => 'after-move';
  h.methods.setSessionMemoryContext();
  h.methods.loadSessionMemories('default', 'after-move', copied);
  assert.equal(h.context.sessionMemoryPanel.currentSid, 'after-move');
  assert.equal(h.context.sessionMemory.getMemories('after-move')[0].id, copied[0].id);
  assert.equal(h.context.deletedSessionMemoryKeys.has('after-move'), false);
  h.enqueue('default', 'after-move', [memory('edited-after-move')]);
  await h.methods.flushSessionMemoryWrites();
  assert.equal(h.saved[0].sid, 'after-move');
  assert.equal(h.context.sessionMemory.getMemories('after-move')[0].id, 'edited-after-move');
}

console.log('PASS session memory lifecycle: deletion, scope isolation, terminal 409, stale tasks/reads, retry, move');
