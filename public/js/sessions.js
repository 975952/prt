import { t as tr, intlLocale } from './i18n.js';
import { windowStorage as localStorage } from './window-storage.js';
/* 会话系统 P0（2026-11，用户拍板 B：进文件夹默认显示空态选择卡片）
 *
 * 这个模块只做「会话管理」这一件事：
 *   - 会话头（标题 / 运行状态点 / 新建 / 历史）
 *   - 快速切换浮层（点标题）
 *   - 全高历史面板（搜索 / 分组 / 行内重命名 / 置顶 / 归档 / 删除 / 应用内确认）
 *   - 进文件夹的简洁入口（继续上次 / 新建 / 历史；默认行为在设置中）
 *   - 会话 meta 接口（GET /api/sessions、PATCH /api/session、DELETE /api/session、move-folder）
 *
 * 与 app.js 的边界：本模块不 import app.js（避免循环依赖），app.js 在启动时调用
 * initSessions(ctx) 注入一组回调（打开/切换/新建/删除会话、渲染结果区、读写当前会话…）。
 * 会话列表的「当前 sid」始终以 app.js 的 activeSidFor 为准，本模块只镜像缓存。
 */

import { $, el, toast } from './util.js';
import { createSessionMove } from './session-move.js';
import { iconEl } from './icons.js';

const ON_ENTER_KEY = 'reader.session.onEnter';     // choose（默认，用户拍板 B）/ resume / new
const ACTIVE_SESSION_KEY = 'reader.activeSession'; // 与 app.js 的 SESSION_KEY 同一个存档
const HIST_MODE_KEY = 'reader.session.historyMode'; // file（按文件整理，默认）/ time（按时间顺序）
const LIST_LIMIT = 300;
const ALL_LIST_LIMIT = 500;
const DAY = 24 * 60 * 60 * 1000;

const ICONS = {
  move: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 5H5v14h8M10 12h11m-4-4 4 4-4 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5.2v13.6M5.2 12h13.6"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6.4h16M4 12h16M4 17.6h16"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.6 5.4 8 12l6.6 6.6"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.4 3.6h5.2l-.7 5.1 3.3 3.3v2.2H6.8v-2.2l3.3-3.3z"/><path d="M12 14.2v6.2"/></svg>',
  archive: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.2h16v3.6H4z"/><path d="M5.4 8.8v9.2a1.6 1.6 0 0 0 1.6 1.6h10a1.6 1.6 0 0 0 1.6-1.6V8.8"/><path d="M10 12.4h4"/></svg>',
  rename: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 19.4h4.2L19 9.2a2.4 2.4 0 0 0-3.4-3.4L5.4 16z"/><path d="m13.8 7.6 3.2 3.2"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 6.6h14.8"/><path d="M9.2 6.6V4.8h5.6v1.8"/><path d="M6.6 6.6 7.4 20h9.2l.8-13.4"/><path d="M10.2 10.4v5.6M13.8 10.4v5.6"/></svg>',
  dot: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7.4"/></svg>',
  doc: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.4 4.4h7.6l4 4v11.2H6.4z"/><path d="M14 4.4v4h4"/><path d="M9 12.4h6M9 15.6h6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7.6"/><path d="M12 7.4V12l3.2 2"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
};

const st = {
  ctx: null,
  folderPath: '',
  folderKey: '',
  docId: '',
  /** 当前文件夹的会话 meta（含已归档，服务端 limit 内） */
  list: [],
  /** scope=all 的缓存：会话历史面板统一用它（两种排列都是全部文件夹的数据） */
  allList: [],
  listLoaded: false,
  listLoading: false,
  allLoading: false,
  /** 镜像 app.js 的 activeSidFor（app 是唯一事实来源，这里只用于渲染） */
  currentSid: '',
  entryVisible: false,
  busy: false,
  historyOpen: false,
  quickOpen: false,
  /** 会话历史的排列方式：file=按文件整理；time=按时间顺序 */
  histMode: 'time',
  histQuery: '',
  quickQuery: '',
  showArchived: false,
  /** null = 没有行处于改名态；'' 是旧默认会话的合法 sid，不能拿它当哨兵 */
  renameSid: null,
  historyMenu: null,
  confirmResolve: null,
  ui: null,
  moveUi: null,
};

/* ───────────────────────────── 基础工具 ───────────────────────────── */

function relTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (!Number.isFinite(min) || min < 1) return tr("刚刚");
  if (min < 60) return tr("{0} 分钟前", min);
  const h = Math.floor(min / 60);
  if (h < 24) return tr("{0} 小时前", h);
  const d = Math.floor(h / 24);
  if (d < 7) return tr("{0} 天前", d);
  const dt = new Date(t);
  return new Intl.DateTimeFormat(intlLocale, { month: 'short', day: 'numeric' }).format(dt);
}

function normalizeRows(raw) {
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    sid: String(r?.sid || ''),
    // 这一行实际所在的 doc key（/api/sessions 给出；旧服务端可能没有）
    fileKey: String(r?.fileKey || ''),
    title: String(r?.title || ''),
    titleSource: String(r?.titleSource || 'auto'),
    preview: String(r?.preview || ''),
    count: Number(r?.count) || 0,
    createdAt: Number(r?.createdAt) || 0,
    updatedAt: Number(r?.updatedAt) || 0,
    lastOpenedAt: Number(r?.lastOpenedAt) || 0,
    pinned: !!r?.pinned,
    pinnedAt: Number(r?.pinnedAt) || 0,
    archived: !!r?.archived,
    archivedAt: Number(r?.archivedAt) || 0,
    folderPath: String(r?.folderPath || ''),
    folderDisplay: String(r?.folderPath || ''),
    docIds: Array.isArray(r?.docIds) ? r.docIds : [],
    docTitles: Array.isArray(r?.docTitles) ? r.docTitles : [],
  }));
}

function readOnEnter() {
  try {
    const v = localStorage.getItem(ON_ENTER_KEY);
    return v === 'resume' || v === 'new' ? v : 'choose';
  } catch { return 'choose'; }
}

function setOnEnter(mode) {
  try { localStorage.setItem(ON_ENTER_KEY, mode); } catch { /* ignore */ }
}

/** 历史面板排列方式：按文件整理（默认）/ 按时间顺序 */
function readHistMode() {
  try { return localStorage.getItem(HIST_MODE_KEY) === 'file' ? 'file' : 'time'; } catch { return 'time'; }
}

function setHistMode(mode) {
  const next = mode === 'time' ? 'time' : 'file';
  if (next === st.histMode) return;
  st.histMode = next;
  try { localStorage.setItem(HIST_MODE_KEY, next); } catch { /* ignore */ }
  st.ui?.history?.querySelectorAll('.sess-arrange-chip').forEach((b) => {
    const on = b.dataset.mode === next;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  renderHistoryList();
}

function isStale(row) {
  if (!row) return true;
  if ((row.count || 0) > 60) return true;
  const ts = row.updatedAt || row.lastOpenedAt || 0;
  return !!ts && (Date.now() - ts) > 7 * DAY;
}

/** 生成中守卫：所有会改变会话归属/显示的动作都要先过这一道（修 v3 缺陷③） */
function guardBusy(label, { navigation = false } = {}) {
  if ((st.busy || st.ctx?.isBusy?.()) && !(navigation && st.ctx?.canSwitchWhileBusy?.())) {
    toast(tr("正在生成中，先等它跑完或点停止再{0}", label), 'err', 3200);
    return false;
  }
  return true;
}

function errorOf(j, r) {
  return j?.error?.message || j?.error || `HTTP ${r.status}`;
}

function sessButton(icon, title, cls, onclick, extra = {}) {
  return el('button', {
    type: 'button',
    class: cls,
    title,
    'aria-label': title,
    html: ICONS[icon] || '',
    onclick,
    ...extra,
  });
}

/* ───────────────────────────── 接口 ───────────────────────────── */

/** 列表/元数据请求用的 doc key：全局共用模式由 app 给出（'default'），其余情况就是当前文件夹 */
function listScopeKey() {
  return st.ctx?.scopeKey?.() || st.folderKey;
}

/** 历史行里的 fileKey 是服务端规范化后的存储键：全局模式下 app 传的 'default' 会落成
 *  'default-<hash>'（见 server.js docIdOf）。这里统一判断「是不是当前归属键的副本」。 */
function isScopeFileKey(fileKey) {
  const key = String(fileKey || '');
  if (!key) return false;
  if (st.ctx?.isScopeFileKey) return !!st.ctx.isScopeFileKey(key);
  return key === listScopeKey();
}

async function fetchSessionRows(scope, limit) {
  const q = new URLSearchParams({
    doc: listScopeKey(),
    folderPath: st.folderPath,
    scope,
    archived: 'all',
    limit: String(limit),
  });
  const r = await fetch(`/api/sessions?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errorOf(j, r));
  return normalizeRows(j.sessions);
}

/** 行所属文件夹的 session key：优先用服务端给的 fileKey（任意归属模式/旧文件夹的行都能
 *  正确置顶、改名、归档、删除）；没有时按 folderPath 现算。 */
function keyForRow(row) {
  if (row?.fileKey) return row.fileKey;
  if (!st.ctx) return st.folderKey;
  const scope = st.ctx.scopeKey?.();
  if (scope && scope !== st.ctx.folderKey?.()) return scope;
  if ((row.folderPath || '') === (st.folderPath || '')) return st.folderKey;
  return st.ctx.folderKeyOf(row.folderPath || '');
}

async function patchMeta(row, patch) {
  try {
    const q = new URLSearchParams({ doc: keyForRow(row), sid: row.sid });
    const r = await fetch(`/api/session?${q}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(errorOf(j, r));
    if (j.session && typeof j.session === 'object') {
      Object.assign(row, j.session);
    }
    if (patch.pinned !== undefined) { row.pinned = !!patch.pinned; row.pinnedAt = patch.pinned ? (row.pinnedAt || Date.now()) : 0; }
    if (patch.archived !== undefined) { row.archived = !!patch.archived; row.archivedAt = patch.archived ? (row.archivedAt || Date.now()) : 0; }
    if (patch.title !== undefined) {
      row.title = String(patch.title || '');
      row.titleSource = patch.title ? 'user' : 'auto';
    }
    cacheTouched(row);
    renderHeader();
    if (st.quickOpen) renderQuickList();
    if (st.historyOpen) renderHistoryList();
    return true;
  } catch (e) {
    toast(tr("会话更新失败：{0}", e.message), 'err', 4200);
    return false;
  }
}

/** 更新列表里的同一行（PATCH 返回的摘要可能没有 count/updatedAt 等展示字段） */
function cacheTouched(row) {
  for (const box of [st.list, st.allList]) {
    const i = box.findIndex((r) => r.sid === row.sid && r.fileKey === row.fileKey);
    if (i >= 0) box[i] = { ...box[i], ...row };
  }
}

/* ───────────────────────────── 列表刷新 ───────────────────────────── */
let listRequest = 0;
let allListRequest = 0;
let docOpenRequest = 0;
const contextKey = () => JSON.stringify([st.ctx?.doc?.()?.docId || '', listScopeKey(), st.ctx?.currentSid?.() || '', !!st.ctx?.isAgentWorkspace?.()]);

async function refreshList({ force = false, allowWithoutDoc = false } = {}) {
  if (!st.ctx || (!allowWithoutDoc && !st.ctx.hasDoc?.())) return st.list;
  st.folderPath = st.ctx.folderPath();
  st.folderKey = st.ctx.folderKey();
  st.docId = st.ctx.doc()?.docId || '';
  st.currentSid = st.ctx.currentSid();
  if (st.listLoading && !force) return st.list;
  const request = ++listRequest, owner = contextKey();
  const current = () => request === listRequest && owner === contextKey();
  st.listLoading = true;
  try {
    const shared = st.ctx.isAgentWorkspace?.();
    const rows = shared ? collapseRows(await fetchSessionRows('all', ALL_LIST_LIMIT)) : await fetchSessionRows('folder', LIST_LIMIT);
    if (!current()) return st.list;
    st.list = rows;
    st.listLoaded = true;
    st.ctx.adoptList?.(rows);
  } catch (e) {
    if (!current()) return st.list;
    if (!st.listLoaded) st.list = [];
    st.listLoaded = true;
    toast(tr("会话列表读取失败：{0}", e.message), 'err', 4200);
  } finally {
    if (request === listRequest) st.listLoading = false;
  }
  if (!current()) return st.list;
  renderHeader();
  if (st.quickOpen) renderQuickList();
  if (st.historyOpen) {
    // 历史面板开着时跨论文/跨归属模式切换：st.list 刷新了，但历史数据源 st.allList
    // 还是旧的 —— 上一篇论文的旧行会被标成「当前」，点击还会按旧 docIds 跳回旧论文。
    // 这里把全库列表一起刷新（都是本地文件，代价很小）。
    await refreshAllList();
  }
  return st.list;
}

async function refreshAllList() {
  if (!st.ctx?.hasDoc?.()) return;
  const request = ++allListRequest, owner = contextKey();
  const current = () => request === allListRequest && owner === contextKey();
  st.allLoading = true;
  if (st.historyOpen) renderHistoryList();
  try {
    const rows = await fetchSessionRows('all', ALL_LIST_LIMIT);
    if (!current()) return;
    st.allList = rows;
  } catch (e) {
    if (!current()) return;
    st.allList = [];
    toast(tr("全部会话读取失败：{0}", e.message), 'err', 4200);
  } finally {
    if (request === allListRequest) st.allLoading = false;
  }
  if (!current()) return;
  if (st.historyOpen) renderHistoryList();
  renderHeader();
}

/* ───────────────────────────── 会话头 ───────────────────────────── */

function currentRow() {
  // currentSid 为空 = 没有活动会话（旧默认会话的 sid 也是空串，不能靠它匹配）
  if (!st.currentSid) return null;
  return st.list.find((r) => r.sid === st.currentSid && hasCurrentOwner(r)) || null;
}

function headerName() {
  if (st.entryVisible) return tr("会话");
  const row = currentRow();
  if (row?.title) return row.title;
  if (st.currentSid) return row?.count ? tr("（无标题会话）") : tr("新会话");
  return tr("会话");
}

function renderHeader() {
  const ui = st.ui;
  if (!ui) return;
  const label = ui.label;
  const name = headerName();
  if (label) label.textContent = name;
  if (ui.btn) {
    ui.btn.title = name;
  }
  if (ui.dot) {
    ui.dot.hidden = !st.busy;
    ui.dot.classList.toggle('running', !!st.busy);
  }
  if (ui.newBtn) ui.newBtn.disabled = !!st.busy && !st.ctx?.canSwitchWhileBusy?.();
  if (ui.histBtn) ui.histBtn.setAttribute('aria-expanded', String(st.historyOpen));
  if (ui.rightSide) {
    if (st.historyOpen) ui.rightSide.dataset.sessView = 'history';
    else delete ui.rightSide.dataset.sessView;
  }
}

export function sessionsRefreshHeader() {
  if (!st.ui) return;
  st.currentSid = st.ctx?.currentSid?.() || '';
  renderHeader();
}

export function sessionsSetBusy(on) {
  st.busy = !!on;
  if (st.busy && !st.ctx?.canSwitchWhileBusy?.()) closeQuick();
  renderHeader();
}

/** 会话发生变化（切换/新建/删除/清空）后：刷新头与缓存列表 */
export async function sessionsOnSessionChanged({ refresh = false } = {}) {
  st.currentSid = st.ctx?.currentSid?.() || '';
  if (refresh) await refreshList({ force: true });
  renderHeader();
  if (st.quickOpen) renderQuickList();
  if (st.historyOpen) {
    // 历史面板开着时，切论文/切归属模式不会经过 openHistory：全库列表必须一起重拉，
    // 否则旧论文的旧行会被标成「当前」、点击还会按旧 docIds 跳回旧论文。
    if (!refresh) await refreshAllList();
    else renderHistoryList();
  }
}

function scopeMode() {
  return st.ctx?.scopeMode?.() || 'folder';
}

/** Enter a conversation workspace independently of the visible PDF. The caller
 * has already selected its scope; lists and entry state must follow that scope. */
export async function sessionsOpenWorkspace({ choose = true } = {}) {
  if (!st.ctx || !st.ui) return;
  const request = ++docOpenRequest, owner = contextKey();
  sessionsCloseOverlays();
  hideEntryCard({ render: false });
  // Do not briefly expose the previous workspace's cached history while loading.
  ++allListRequest;
  st.allLoading = false;
  st.allList = [];
  st.list = [];
  st.listLoaded = false;
  st.docId = st.ctx.doc?.()?.docId || '';
  st.currentSid = st.ctx.currentSid?.() || '';
  await refreshList({ force: true, allowWithoutDoc: true });
  if (request !== docOpenRequest || owner !== contextKey()) return;
  st.currentSid = st.ctx.currentSid?.() || '';
  if (choose) {
    const recent = activeRows().filter((row) => (row.count || 0) > 0);
    showEntryCard(recent.find((row) => row.sid === st.currentSid) || recent[0] || null);
  } else {
    st.ctx.showChatAndRender?.();
    await st.ctx.followCurrentSession?.();
    if (request !== docOpenRequest || owner !== contextKey()) return;
    renderHeader();
  }
}

/** Close transient session controls before a workspace or reader handoff. */
export function sessionsCloseOverlays() {
  st.moveUi?.close({ focus: false, force: true });
  closeQuick();
  closeHistory();
  if (st.confirmResolve) resolveConfirm(false);
}

/** app.js 刚打开一篇文档：决定「接上哪段对话」或「按打开文件夹时的策略执行」 */
export async function sessionsOnDocOpened(docId) {
  const request = ++docOpenRequest, openedDoc = String(docId || '');
  const openedScope = listScopeKey();
  st.docId = String(docId || '');
  st.currentSid = st.ctx?.currentSid?.() || '';
  // 先把上一轮可能残留的选择卡片收起来（aiArea 里可能还挂着旧节点）
  st.entryVisible = false;
  if (st.ui?.entry) { st.ui.entry.dataset.show = '0'; st.ui.entry.classList.add('hidden'); }
  st.ctx?.renderAi?.();

  await refreshList({ force: true });
  if (request !== docOpenRequest || !st.ctx?.hasDoc?.() || (st.ctx.doc()?.docId || '') !== openedDoc || listScopeKey() !== openedScope) return;

  st.currentSid = st.ctx?.currentSid?.() || '';
  // 历史面板/选择卡片已经指定了要打开的会话：打开文档只是顺路加载论文，
  // 不要再按「打开文件夹时」策略弹卡片或另开新会话（否则会冲掉刚指定的会话）。
  if (st.ctx?.consumeSessionOpen?.()) {
    st.ctx?.consumeFolderEntry?.();   // 这次只算「打开论文」，不算按策略进入文件夹
    st.ctx?.showChatAndRender?.();
    return;
  }

  if (st.ctx?.hasLiveConversation?.()) {
    st.ctx?.consumeFolderEntry?.();
    st.ctx?.showChatAndRender?.();
    await st.ctx.followCurrentSession?.();
    return;
  }

  // openDoc 每次冷开论文都会走到这里，但「打开文件夹时」的三档只应该在一个文件夹
  // 真正被打开时生效（换文件夹、启动、文件夹从关闭状态恢复）。同一文件夹里切到
  // 另一篇论文时按「会话归属」静默接上 —— 不弹卡片、不新建。
  if (!st.ctx?.consumeFolderEntry?.()) {
    st.ctx?.showChatAndRender?.();
    const cur = st.currentSid ? (st.list.find((r) => r.sid === st.currentSid) || null) : null;
    if (cur) { await (st.ctx.followCurrentSession || st.ctx.restoreChatOnly)?.(); return; }   // 当前会话就是这里的：同一段对话跟着，内容一致就不重放 DOM
    if (st.currentSid) {
      // 指针指向一个还没落盘的空会话：保持空白，但要把上一篇残留在 DOM 里的消息清掉
      await st.ctx.startNewSession?.({ silent: true, fromEntry: true });
      return;
    }
    const actives = activeRows().filter((r) => (r.count || 0) > 0 && !isStale(r));
    if (actives.length) await st.ctx.continueSession?.(actives[0].sid, { force: true });
    else await st.ctx.startNewSession?.({ silent: true, fromEntry: true });
    return;
  }

  // 真正打开一个文件夹：按「打开文件夹时」的三档执行
  const onEnter = readOnEnter();
  // 「继续上次」只认有内容的会话：新建后没发过消息的空会话不该抢这个位置
  const actives = activeRows().filter((r) => (r.count || 0) > 0);
  const curRow = st.currentSid ? actives.find((r) => r.sid === st.currentSid) || null : null;
  const last = curRow || actives[0] || null;

  if (onEnter === 'new') {
    // 默认「总是新会话」：旧行为 —— 直接开一个新会话，并让问答面板可见
    st.ctx?.showChatAndRender?.();
    await st.ctx.startNewSession({ silent: true, fromEntry: true });
    return;
  }
  if (onEnter === 'resume' && last && !isStale(last)) {
    // 默认「自动恢复上次」：让问答面板可见，再恢复/切换
    st.ctx?.showChatAndRender?.();
    if (last.sid === st.currentSid) await st.ctx.restoreChatOnly?.();
    else await st.ctx.continueSession(last.sid, { force: true });
    return;
  }
  showEntryCard(last);
}

function activeRows() {
  return st.list
    .filter((r) => !r.archived)
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
}

/* ───────────────────────────── 进文件夹选择卡片 ───────────────────────────── */

function showEntryCard(lastRow) {
  st.entryVisible = true;
  renderEntryCard(lastRow);
  if (st.ui?.entry) {
    st.ui.entry.dataset.show = '1';
    st.ui.entry.classList.remove('hidden');
  }
  st.ctx?.showChatAndRender?.();
  renderHeader();
}

function hideEntryCard({ render = true } = {}) {
  st.entryVisible = false;
  if (st.ui?.entry) {
    st.ui.entry.dataset.show = '0';
    st.ui.entry.classList.add('hidden');
  }
  if (render) st.ctx?.renderAi?.();
  renderHeader();
}

function renderEntryCard(lastRow) {
  const ui = st.ui;
  if (!ui?.entry) return;
  const agentWorkspace = !!st.ctx?.isAgentWorkspace?.();
  ui.entry.classList.toggle('agent-entry', agentWorkspace);
  if (agentWorkspace) {
    const recent = activeRows().filter((row) => (row.count || 0) > 0)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 3);
    ui.entry.replaceChildren(
      el('div', { class: 'entry-heading' },
        el('h3', { class: 'entry-title', text: tr("全局助手") }),
        el('button', { type: 'button', class: 'entry-link', text: tr("全部会话"), onclick: openHistory })),
      el('button', { type: 'button', class: 'entry-new', text: tr("新建会话"), onclick: doNewSession }),
      ...(recent.length ? [el('div', { class: 'agent-entry-recent' },
        ...recent.map((row) => {
          const name = row.title || tr("未命名会话");
          return el('button', { type: 'button', class: 'entry-primary',
            title: tr("继续「{0}」", name), onclick: () => chooseSession(row) },
          el('span', { class: 'entry-primary-main', text: name }),
          el('span', { class: 'entry-primary-meta', text: tr("{0} 条消息 · {1}", row.count, relTime(row.updatedAt)) }),
          el('span', { class: 'entry-continue', text: tr("继续对话 →") }));
        }))] : []),
    );
    return;
  }
  if (!lastRow) {
    ui.entry.replaceChildren(st.ctx.createReadingWelcome('chat'));
    return;
  }
  const name = lastRow.title || tr("未命名会话");
  ui.entry.replaceChildren(
    el('div', { class: 'entry-heading' },
      el('h3', { class: 'entry-title', text: tr("接着上次聊") }),
      el('button', { type: 'button', class: 'entry-link', text: tr("全部会话"), onclick: openHistory })),
    el('button', { type: 'button', class: 'entry-primary', title: tr("继续「{0}」", name), onclick: () => chooseSession(lastRow) },
      el('span', { class: 'entry-primary-main', text: name }),
      el('span', { class: 'entry-primary-meta', text: tr("{0} 条消息 · {1}", lastRow.count, relTime(lastRow.updatedAt)) }),
      el('span', { class: 'entry-continue', text: tr("继续对话 →") })),
    el('button', { type: 'button', class: 'entry-new', text: tr("新建会话"), onclick: doNewSession }),
  );
}

async function chooseSession(row, docIdHint = '') {
  if (!guardBusy(tr("切换会话"), { navigation: true })) return;
  // 历史面板的新排列会列出别的文件夹/别的论文的会话：拿到整行才能切文件夹、打开对应论文。
  // docIdHint：按文件排列时用户点的是哪篇论文分组 —— 优先在原论文打开会话，别乱跳。
  closeQuick();
  closeHistory();
  const force = st.entryVisible;
  hideEntryCard();
  if (st.ctx?.openSessionFromHistory) await st.ctx.openSessionFromHistory(row, { force, docIdHint });
  else await st.ctx.continueSession(row.sid, { force });
}

async function doNewSession() {
  if (!guardBusy(tr("新建会话"), { navigation: true })) return;
  const wasEntry = st.entryVisible;
  closeQuick();
  closeHistory();
  hideEntryCard();
  await st.ctx.startNewSession({ silent: false, fromEntry: wasEntry });
}

/* ───────────────────────────── 快速切换浮层 ───────────────────────────── */

function moveRow(row) {
  if (!row?.fileKey) return null;
  const actual = [...st.allList, ...st.list].find(value => value.sid === row.sid && value.fileKey === row.fileKey) || row;
  return Number(actual.count) > 0 ? { ...row, ...actual } : null;
}

function currentMoveRow() {
  if (st.entryVisible) return null;
  const sid = st.ctx?.currentSid?.() ?? st.currentSid;
  const live = st.ctx?.currentSessionMeta?.();
  if (live && live.sid === sid && live.fileKey && isScopeFileKey(live.fileKey)) return Number(live.count) > 0 ? { ...live } : null;
  if (!sid) return null;
  return moveRow(st.list.find(row => row.sid === sid && isScopeFileKey(row.fileKey)));
}

function openSessionMove(row, trigger, { current = false } = {}) {
  const source = current ? currentMoveRow() : moveRow(row);
  if (!source) return;
  closeQuick();
  void st.moveUi?.open(source, trigger);
}

export function sessionsMoveCurrent(trigger) {
  openSessionMove(null, trigger, { current: true });
}

function buildQuick() {
  const quick = st.ui.quick;
  if (!quick) return;
  const search = el('input', {
    type: 'search',
    class: 'sess-quick-search',
    placeholder: tr("搜索会话标题…"),
    'aria-label': tr("搜索会话"),
    oninput: (e) => { st.quickQuery = e.target.value; renderQuickList(); },
  });
  const more = sessButton('more', tr('更多操作'), 'sess-quick-more', () => setQuickMore(), {
    id: 'sessQuickMore', hidden: true, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'sessQuickMenu',
  });
  more.title = tr('更改当前会话归属');
  more.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); setQuickMore(true);
  });
  const menu = el('div', { id: 'sessQuickMenu', class: 'sess-quick-menu', role: 'menu', hidden: true, 'aria-label': tr('更多操作') },
    el('button', { type: 'button', role: 'menuitem', tabindex: '-1', class: 'sess-quick-move', id: 'sessQuickMove',
      onclick: () => openSessionMove(null, st.ui.btn, { current: true }) },
    el('span', { html: ICONS.move }), el('span', { text: tr('更改归属') })));
  menu.addEventListener('keydown', event => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
    if (event.key === 'Tab') { setQuickMore(false, { focus: true }); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); menu.querySelector('button')?.focus({ preventScroll: true });
    }
  });
  quick.replaceChildren(
    search,
    el('div', { class: 'sess-quick-list', id: 'sessQuickList' }),
    el('div', { class: 'sess-quick-foot' },
      el('button', {
        type: 'button', class: 'sess-quick-all', title: tr('查看全部会话'),
        onclick: () => { closeQuick(); openHistory(); },
      }, el('span', { html: ICONS.clock }), el('span', { text: tr('历史') })),
      el('button', { type: 'button', class: 'sess-quick-new', title: tr('新对话'), onclick: doNewSession },
        el('span', { html: ICONS.plus }), el('span', { text: tr('新建') })), more, menu),
  );
  quick.addEventListener('keydown', event => {
    if (event.target.closest('.sess-quick-menu')) return;
    const rows = [...quick.querySelectorAll('.sess-quick-row')];
    const index = rows.indexOf(document.activeElement);
    if (!rows.length || (index < 0 && event.target !== search) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target === search && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next].focus({ preventScroll: true }); rows[next].scrollIntoView({ block: 'nearest' });
  });
  quick.addEventListener('pointerdown', event => {
    if (!event.target.closest('#sessQuickMore, #sessQuickMenu')) setQuickMore(false);
  });
}

function setQuickMore(open, { focus = false } = {}) {
  const menu = st.ui?.quick?.querySelector('#sessQuickMenu'), trigger = st.ui?.quick?.querySelector('#sessQuickMore');
  if (!menu || !trigger) return;
  const show = !trigger.hidden && (open ?? menu.hidden);
  menu.hidden = !show; trigger.setAttribute('aria-expanded', String(show));
  if (show) menu.querySelector('button')?.focus({ preventScroll: true });
  else if (focus) trigger.focus({ preventScroll: true });
}

function openQuick() {
  if (!st.ctx?.hasDoc?.()) return;
  st.quickOpen = true;
  st.ui.quick?.classList.remove('hidden');
  st.ui.btn?.setAttribute('aria-expanded', 'true');
  renderQuickList();
  refreshList({ force: false });
  setTimeout(() => st.ui.quick?.querySelector('.sess-quick-search')?.focus(), 0);
}

function closeQuick({ focus = false } = {}) {
  if (!st.quickOpen) return;
  setQuickMore(false);
  st.quickOpen = false;
  st.ui.quick?.classList.add('hidden');
  st.ui.btn?.setAttribute('aria-expanded', 'false');
  if (focus) st.ui.btn?.focus({ preventScroll: true });
}

function toggleQuick() {
  if (st.quickOpen) closeQuick();
  else openQuick();
}

function renderQuickList() {
  const box = st.ui?.quick?.querySelector('.sess-quick-list');
  if (!box) return;
  const more = st.ui.quick.querySelector('#sessQuickMore');
  if (more) { more.hidden = !currentMoveRow() || typeof st.ctx?.moveSession !== 'function'; if (more.hidden) setQuickMore(false); }
  const q = st.quickQuery.trim().toLowerCase();
  const actives = activeRows()
    .filter((r) => (r.count || 0) > 0)
    .filter((r) => !q || (r.title || '').toLowerCase().includes(q) || (r.preview || '').toLowerCase().includes(q))
    .slice(0, 6);
  if (!actives.length) {
    box.replaceChildren(el('div', { class: 'sess-empty', text: q ? tr("没有匹配的会话") : tr("还没有会话") }));
    return;
  }
  box.replaceChildren(...actives.map((r) => el('button', {
    type: 'button',
    class: `sess-quick-row${r.sid === st.currentSid ? ' on' : ''}`,
    'aria-current': r.sid === st.currentSid ? 'true' : 'false',
    dataset: { sid: r.sid },
    title: r.title || tr("（无标题会话）"),
    onclick: () => chooseSession(r),
  },
  el('span', { class: 'sess-quick-name', text: r.title || (r.count ? tr("（无标题会话）") : tr("新会话")) }),
  r.pinned ? el('span', { class: 'sess-quick-status', title: tr('置顶'), 'aria-label': tr('置顶'), html: ICONS.pin }) : null,
  r.sid === st.currentSid ? el('span', { class: 'sess-quick-status', 'aria-hidden': 'true' }, iconEl('check', { size: 14 })) : null)));
}

/* ───────────────────────────── 历史面板 ───────────────────────────── */

/* ── 历史面板：两种排列 ─────────────────────────────────────────────────
 * file（按文件整理）：同一个会话在它问过的每一篇论文下各出现一次（文件内去重），
 *   文件组按最近活动倒序；没有 docId 的旧会话归入末尾「未关联论文」。
 * time（按时间顺序）：全部会话按更新/置顶排序，每行标出「按先后问过哪些论文」。
 * 两种模式都展示全部文件夹的会话；搜索、置顶/归档/改名/删除、归档折叠共用。 */

function arrangeChip(mode, text, icon, title) {
  const on = st.histMode === mode;
  return el('button', {
    type: 'button',
    class: `sess-arrange-chip${on ? ' on' : ''}`,
    dataset: { mode },
    title,
    'aria-pressed': String(on),
    onclick: () => setHistMode(mode),
  },
  el('span', { class: 'sess-arrange-ic', html: ICONS[icon] || '' }),
  el('span', { text }));
}

function buildHistory() {
  const box = st.ui.history;
  if (!box) return;
  const search = el('input', {
    type: 'search',
    class: 'sess-hist-search',
    placeholder: tr("搜索会话标题、预览或论文名…"),
    'aria-label': tr("搜索会话"),
    oninput: (e) => { st.histQuery = e.target.value; renderHistoryList(); },
  });
  box.replaceChildren(
    el('div', { class: 'sess-hist-head' },
      sessButton('back', tr("返回对话"), 'sess-hist-back', closeHistory),
      el('div', { class: 'sess-hist-title', text: tr("会话历史") }),
      el('button', { type: 'button', class: 'sess-hist-new', text: tr("＋ 新建"), onclick: doNewSession })),
    el('div', { class: 'sess-hist-searchrow' }, search),
    el('div', { class: 'sess-hist-arrange', id: 'sessHistArrange' },
      el('div', { class: 'sess-arrange-chips', role: 'group', 'aria-label': tr("会话排列方式") },
        arrangeChip('file', tr("按文件"), 'doc', tr("同一篇论文的会话归在一起：问过它的每个会话都在该论文下显示一次")),
        arrangeChip('time', tr("按时间"), 'clock', tr("全部会话按时间排列，并标出按顺序问过哪些论文"))),
      el('span', { class: 'sess-hist-summary', id: 'sessHistSummary' })),
    el('div', { class: 'sess-hist-list', id: 'sessHistList' }),
    el('div', { class: 'sess-hist-foot' },
      el('button', { type: 'button', class: 'sess-foot-btn', id: 'sessHistMemory', onclick: () => st.ctx.togglePaperMemory?.() }),
      el('button', { type: 'button', class: 'sess-foot-btn', text: tr("会话设置"), title: tr("会话归属、进入方式与标题策略"), onclick: () => st.ctx.openSessionSettings?.() }),
      el('button', { type: 'button', class: 'sess-foot-btn', text: tr("清空当前会话"), onclick: clearCurrent })),
  );
  renderHistoryList();
  renderMemoryBtn();
}

function renderMemoryBtn() {
  const btn = st.ui?.history?.querySelector('#sessHistMemory');
  if (!btn) return;
  btn.hidden = !!st.ctx?.isAgentWorkspace?.() || !st.ctx?.doc?.()?.docId;
  const off = !!st.ctx?.paperMemoryOff?.();
  btn.textContent = off ? tr("论文记忆：关") : tr("论文记忆：开");
  btn.setAttribute('aria-pressed', String(!off));
  btn.title = tr("新会话是否参考这篇论文之前会话的摘要；不影响各会话自己的历史");
}

async function openHistory() {
  if (!st.ctx?.hasDoc?.()) return;
  st.ctx.onOpenHistory?.();
  st.historyOpen = true;
  st.renameSid = null;
  st.histMode = readHistMode();
  st.ui.history?.classList.remove('hidden');
  buildHistory();
  renderHeader();
  refreshList({ force: false });
  await refreshAllList();
}

function closeHistory() {
  closeHistoryMenu();
  if (!st.historyOpen) return;
  st.historyOpen = false;
  st.renameSid = null;
  st.ui.history?.classList.add('hidden');
  renderHeader();
}

function toggleHistory() {
  if (st.historyOpen) closeHistory();
  else openHistory();
}

function historySourceRows() {
  // 历史面板统一展示全部文件夹的会话；两种排列都基于这一份数据
  return st.allList;
}

/** 同一个会话可能因为切换「换论文时对话怎么接」而在多个存储键下留下副本
 *  （切换时会先按旧方式存盘、再把同一段对话复制到新方式）。历史面板是全库列表，
 *  如果不去重，同一段对话会重复出现好几行、每行都标「当前」。这里按 sid 合并成一行：
 *  · 优先最近更新的一份，时间相同则优先当前归属；
 *  · 标题、置顶、归档、摘要等可能只写在某一副本上，合并时取更完整的值；
 *  · _copies 记录列表内的归属，用于打开会话和标记当前行。 */
function preferRow(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  const aCur = isScopeFileKey(a.fileKey);
  const bCur = isScopeFileKey(b.fileKey);
  if (aCur !== bCur) return aCur;
  const aTitle = !!a.title;
  const bTitle = !!b.title;
  if (aTitle !== bTitle) return aTitle;
  if (!!a.pinned !== !!b.pinned) return !!a.pinned;
  if (!!a.archived !== !!b.archived) return !!a.archived;
  return false;
}

function collapseRows(rows) {
  const groups = new Map();
  const order = [];
  for (const row of rows) {
    const sid = String(row?.sid || '');
    if (!sid) { order.push(row); continue; }   // 没有 sid 的旧行原样保留
    let g = groups.get(sid);
    if (!g) { g = []; groups.set(sid, g); order.push(g); }
    g.push(row);
  }
  return order.map((item) => {
    if (!Array.isArray(item)) return item;
    let primary = item[0];
    for (const r of item) if (preferRow(r, primary)) primary = r;
    const merged = { ...primary };
    for (const r of item) {
      if (!merged.title && r.title) { merged.title = r.title; merged.titleSource = r.titleSource; }
      if (!merged.preview && r.preview) merged.preview = r.preview;
      if (!merged.summary && r.summary) { merged.summary = r.summary; merged.summaryCovered = r.summaryCovered; }
      if (r.pinned) {
        migratedPinned(merged, r);
      }
      if (r.archived) {
        migratedArchived(merged, r);
      }
      merged.count = Math.max(merged.count || 0, r.count || 0);
      merged.updatedAt = Math.max(merged.updatedAt || 0, r.updatedAt || 0);
      merged.lastOpenedAt = Math.max(merged.lastOpenedAt || 0, r.lastOpenedAt || 0);
    }
    if (item.length > 1) {
      // 不同归属键下的副本 docIds 可能各只覆盖一部分论文（切换归属时旧代码只写当前论文），
      // 合并时必须取并集，否则历史分组、trail、点击目标都会缺论文。
      const primaryFirst = [primary, ...item.filter((r) => r !== primary)];
      const seenDoc = new Set();
      const docIds = [];
      const docTitles = [];
      for (const r of primaryFirst) {
        const ids = Array.isArray(r.docIds) ? r.docIds : [];
        const titles = Array.isArray(r.docTitles) ? r.docTitles : [];
        for (let i = 0; i < ids.length; i++) {
          const id = String(ids[i] || '');
          if (!id || seenDoc.has(id)) continue;
          seenDoc.add(id);
          docIds.push(id);
          docTitles.push(String(titles[i] || ''));
        }
      }
      if (docIds.length) { merged.docIds = docIds; merged.docTitles = docTitles; }
      merged._copies = item.map((r) => ({ sid: r.sid, fileKey: r.fileKey, folderPath: r.folderPath }));
    } else {
      delete merged._copies;
    }
    return merged;
  });
}

function migratedPinned(target, row) {
  target.pinned = true;
  target.pinnedAt = Math.max(target.pinnedAt || 0, row.pinnedAt || 0);
}

function migratedArchived(target, row) {
  target.archived = true;
  target.archivedAt = Math.max(target.archivedAt || 0, row.archivedAt || 0);
}

function rowsForGroups() {
  const q = st.histQuery.trim().toLowerCase();
  const filtered = historySourceRows()
    .filter((r) => !q
      || (r.title || '').toLowerCase().includes(q)
      || (r.preview || '').toLowerCase().includes(q)
      || (r.folderPath || '').toLowerCase().includes(q)
      || (r.docTitles || []).some((t) => String(t || '').toLowerCase().includes(q)))
    // 空会话（没发过任何消息、也没被命名/置顶/归档）没有可恢复内容，不占历史列表
    .filter((r) => (r.count || 0) > 0 || r.pinned || r.archived || !!r.title);
  return collapseRows(filtered);
}

/* ── 「按文件整理」：会话 → 问过的论文 ─────────────────────────────────── */

/** docId → { name, folder }：磁盘上的论文优先，会话里存的 docTitles 兜底
 *  （论文被移出 papers/ 后，历史里仍然要认得它）。 */
function docNameIndex(rows) {
  const map = new Map();
  for (const p of (st.ctx?.papers?.() || [])) {
    const id = String(p?.docId || '');
    if (id) map.set(id, { name: String(p.name || ''), folder: String(p.folder || '') });
  }
  for (const r of rows) {
    const ids = Array.isArray(r.docIds) ? r.docIds : [];
    const titles = Array.isArray(r.docTitles) ? r.docTitles : [];
    for (let i = 0; i < ids.length; i++) {
      const id = String(ids[i] || '');
      if (!id || map.has(id)) continue;
      const title = String(titles[i] || '').replace(/\.pdf$/i, '');
      if (title) map.set(id, { name: title, folder: String(r.folderPath || '') });
    }
  }
  return map;
}

function docLabel(row, id, index) {
  const hit = index.get(id);
  if (hit?.name) return hit.name;
  const i = (row.docIds || []).map(String).indexOf(id);
  const title = i >= 0 ? String((row.docTitles || [])[i] || '') : '';
  return title || tr("未知论文");
}

/** 按论文分组；同一会话在它问过的每篇论文下各出现一次（文件内按 sid 去重）。
 *  组内排序：置顶优先，再按更新时间倒序；组之间按最近活动倒序，未关联论文组排最后。 */
function fileGroups(rows) {
  const index = docNameIndex(rows);
  const groups = new Map();
  const misc = { id: '', name: tr("未关联论文"), folder: '', rows: [], latest: 0 };
  for (const r of rows) {
    const ids = Array.from(new Set((r.docIds || []).map(String).filter(Boolean)));
    if (!ids.length) {
      misc.rows.push(r);
      misc.latest = Math.max(misc.latest, r.updatedAt || 0);
      continue;
    }
    for (const id of ids) {
      let g = groups.get(id);
      if (!g) {
        const hit = index.get(id);
        g = {
          id,
          name: hit?.name || docLabel(r, id, index),
          folder: hit ? hit.folder : String(r.folderPath || ''),
          rows: [],
          latest: 0,
        };
        groups.set(id, g);
      }
      g.rows.push(r);
      g.latest = Math.max(g.latest, r.updatedAt || 0);
    }
  }
  const out = [...groups.values()].sort((a, b) => (b.latest || 0) - (a.latest || 0));
  if (misc.rows.length) out.push(misc);
  for (const g of out) {
    g.rows.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }
  return out;
}

function bucketOf(ts) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const today0 = d.getTime();
  if (!ts || ts >= today0) return 0;
  if (ts >= today0 - DAY) return 1;
  if (ts >= today0 - 7 * DAY) return 2;
  return 3;
}

/** 时间模式/归档的分组标题：左侧主标题 + 右侧数量，避免和会话行抢视觉重心 */
function groupHead(label, count, { button = false, onclick = null } = {}) {
  const kids = [
    el('span', { class: 'sess-group-label', text: label }),
    count ? el('span', { class: 'sess-group-count', text: String(count) }) : null,
  ];
  if (button) {
    return el('button', { type: 'button', class: 'sess-group sess-group-btn', onclick },
      ...kids.filter(Boolean));
  }
  return el('div', { class: 'sess-group' }, ...kids.filter(Boolean));
}

function renderHistoryList() {
  const box = st.ui?.history?.querySelector('.sess-hist-list');
  if (!box) return;
  closeHistoryMenu();
  const rows = rowsForGroups();
  const globalScope = scopeMode() === 'global';
  const arrangement = st.ui?.history?.querySelector('.sess-arrange-chips');
  if (arrangement) arrangement.hidden = globalScope;
  const summary = st.ui?.history?.querySelector('#sessHistSummary');
  if (summary) {
    summary.textContent = rows.length ? tr("{0} 个会话", rows.length) : '';
  }
  if (st.allLoading && !st.allList.length) {
    box.replaceChildren(el('div', { class: 'sess-empty', text: tr("正在读取全部会话…") }));
    return;
  }
  const active = rows.filter((r) => !r.archived);
  const archived = rows.filter((r) => r.archived);
  const nodes = [];
  // 按文件模式下同一会话会出现在多个文件组：行内改名只在第一次出现的那行渲染输入框，
  // 「当前」徽标也只标第一次出现的那行
  const renameShown = new Set();
  const currentShown = new Set();

  if (st.histMode === 'file' && !globalScope) {
    const groups = fileGroups(active);
    for (const g of groups) {
      const pathText = g.folder ? `papers / ${g.folder.replace(/\//g, ' / ')}` : 'papers/';
      nodes.push(el('div', { class: 'sess-fileblock' },
        el('div', { class: 'sess-filegroup' },
          el('span', { class: 'sess-filegroup-ic', html: ICONS.doc }),
          el('span', { class: 'sess-filegroup-name', text: g.name, title: g.name }),
          el('span', { class: 'sess-filegroup-count', text: String(g.rows.length) })),
        el('div', { class: 'sess-filegroup-sub', text: pathText })));
      const rowsBox = el('div', { class: 'sess-fileblock-rows' });
      for (const r of g.rows) rowsBox.append(historyRow(r, { group: g, renameShown, currentShown }));
      nodes.push(rowsBox);
    }
  } else {
    const pinned = active.filter((r) => r.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
    if (pinned.length) {
      nodes.push(groupHead(tr("置顶"), pinned.length));
      nodes.push(...pinned.map((r) => historyRow(r, { renameShown, currentShown })));
    }
    const rest = active.filter((r) => !r.pinned);
    const buckets = [[], [], [], []];
    for (const r of rest) buckets[bucketOf(r.updatedAt)].push(r);
    const labels = [tr("今天"), tr("昨天"), tr("最近 7 天"), tr("更早")];
    for (let i = 0; i < buckets.length; i++) {
      if (!buckets[i].length) continue;
      nodes.push(groupHead(labels[i], buckets[i].length));
      for (const r of buckets[i]) nodes.push(historyRow(r, { renameShown, currentShown }));
    }
  }
  if (archived.length) {
    nodes.push(groupHead(tr("{0} 已归档", st.showArchived ? '▾' : '▸'), archived.length, {
      button: true,
      onclick: () => { st.showArchived = !st.showArchived; renderHistoryList(); },
    }));
    if (st.showArchived) {
      for (const r of archived) nodes.push(historyRow(r, { renameShown, currentShown }));
    }
  }
  if (!nodes.length) {
    nodes.push(el('div', {
      class: 'sess-empty',
      text: st.histQuery.trim()
        ? tr("没有匹配的会话")
        : tr("还没有会话"),
    }));
  }
  box.replaceChildren(...nodes);
}

function closeHistoryMenu({ focus = false } = {}) {
  const menu = st.historyMenu;
  if (!menu) return;
  st.historyMenu = null;
  menu.trigger.setAttribute('aria-expanded', 'false');
  menu.trigger.removeAttribute('aria-controls');
  menu.panel.remove();
  if (focus && menu.trigger.isConnected) menu.trigger.focus({ preventScroll: true });
}

function focusHistoryRow(row) {
  if (!st.historyOpen) return;
  const current = document.activeElement;
  if (current && current !== document.body && current.getClientRects().length) return;
  const match = [...st.ui.history.querySelectorAll('.sess-hrow')]
    .find(node => node.dataset.sid === row.sid && node.dataset.fileKey === row.fileKey);
  (match?.querySelector('.sess-hmore') || st.ui.history.querySelector('.sess-hist-search'))?.focus({ preventScroll: true });
}

function openHistoryMenu(row, trigger) {
  if (st.historyMenu?.trigger === trigger) { closeHistoryMenu({ focus: true }); return; }
  closeHistoryMenu();
  const panel = el('div', { id: 'sessRowMenu', class: 'sess-row-menu', role: 'menu', 'aria-label': tr('更多操作') });
  const action = (icon, label, cls, callback, { restore = true } = {}) => el('button', {
    type: 'button', role: 'menuitem', tabindex: '-1', class: `sess-hact ${cls}`,
    onclick: async (event) => {
      event.stopPropagation();
      closeHistoryMenu({ focus: true });
      await callback();
      if (restore) focusHistoryRow(row);
    },
  }, el('span', { class: 'sess-row-menu-icon', html: ICONS[icon] }), el('span', { text: label }));
  panel.append(
    action('pin', row.pinned ? tr('取消置顶') : tr('置顶'), `pin${row.pinned ? ' on' : ''}`, () => patchMeta(row, { pinned: !row.pinned })),
    action('archive', row.archived ? tr('取消归档') : tr('归档'), `archive${row.archived ? ' on' : ''}`, () => patchMeta(row, { archived: !row.archived })),
    action('rename', tr('重命名'), 'rename', () => startRename(row.sid), { restore: false }),
  );
  if (moveRow(row) && typeof st.ctx?.moveSession === 'function') {
    panel.append(action('move', tr('更改归属'), 'move', () => openSessionMove(row, trigger), { restore: false }));
  }
  panel.append(action('trash', tr('删除会话'), 'danger', () => confirmDeleteRow(row)));
  panel.addEventListener('keydown', event => {
    // Menu focus owns ordinary keys; reader shortcuts (for example R and
    // PageDown) must not act on the PDF behind it. Keep native button defaults.
    if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
    if (event.key === 'Tab') { closeHistoryMenu({ focus: true }); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = [...panel.querySelectorAll('[role="menuitem"]')];
    const active = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
    items[next]?.scrollIntoView({ block: 'nearest' });
  });
  // A body portal keeps the menu outside the history scroller. Match its CSS
  // zoom so a scaled full-screen workspace retains both size and anchor position.
  let scale = 1;
  for (let node = trigger; node && node !== document.body; node = node.parentElement) {
    const zoom = Number.parseFloat(getComputedStyle(node).zoom);
    if (Number.isFinite(zoom) && zoom > 0) scale *= zoom;
  }
  panel.style.zoom = String(scale);
  panel.style.maxHeight = `${Math.max(64, window.innerHeight - 16) / scale}px`;
  panel.style.maxWidth = `${Math.max(64, window.innerWidth - 16) / scale}px`;
  document.body.append(panel);
  const anchor = trigger.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8));
  const below = anchor.bottom + 5;
  const top = below + bounds.height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - bounds.height - 5);
  panel.style.left = `${left / scale}px`;
  panel.style.top = `${top / scale}px`;
  st.historyMenu = { panel, trigger, row };
  trigger.setAttribute('aria-expanded', 'true');
  trigger.setAttribute('aria-controls', panel.id);
  panel.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
}

function hasCurrentOwner(row) {
  return (!row.fileKey && !row._copies?.length) || isScopeFileKey(row.fileKey)
    || !!row._copies?.some(copy => isScopeFileKey(copy.fileKey));
}

function historyRow(row, { group = null, renameShown = null, currentShown = null } = {}) {
  // 按文件排列时同一会话可能出现在多个论文分组里；「当前」徽标只标第一次，
  // 否则同一个会话会同时有好几行写「当前」，看起来像有好几个当前会话。
  // 还要防历史数据过期（切换论文/归属模式后旧列表没刷新）：只有这一行确实有当前
  // 归属键下的副本、且（按文件时）就在当前论文分组里，才允许标「当前」。
  const docNow = String(st.ctx?.doc?.()?.docId || '');
  const groupOk = st.histMode !== 'file' || !group?.id || !docNow || String(group.id) === docNow;
  const canMarkCurrent = !st.entryVisible && !!st.currentSid && row.sid === st.currentSid
    && hasCurrentOwner(row) && groupOk
    && !(currentShown && currentShown.has(row.sid));
  const on = canMarkCurrent;
  if (on && currentShown) currentShown.add(row.sid);
  const title = row.title || (row.count ? tr("（无标题会话）") : tr("新会话"));
  const meta = relTime(row.updatedAt || row.lastOpenedAt || row.createdAt);

  const wrap = el('div', { class: `sess-hrow${on ? ' on' : ''}${row.archived ? ' archived' : ''}`, dataset: { sid: row.sid, fileKey: row.fileKey || '' } });

  const canRenameHere = st.renameSid === row.sid && (st.histMode !== 'file' || !renameShown?.has(row.sid));
  if (canRenameHere) {
    renameShown?.add(row.sid);
    const input = el('input', { class: 'sess-rename-input', value: row.title || '' });
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      st.renameSid = null;
      if (!next || next === row.title) { renderHistoryList(); focusHistoryRow(row); return; }
      await patchMeta(row, { title: next });
      renderHistoryList();
      focusHistoryRow(row);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; st.renameSid = null; renderHistoryList(); focusHistoryRow(row); }
    });
    input.addEventListener('blur', commit);
    wrap.append(el('div', { class: 'sess-hgo' }, input));
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return wrap;
  }

  wrap.append(
    el('button', {
      type: 'button', class: 'sess-hgo', title, 'aria-current': on ? 'true' : null,
      onclick: () => chooseSession(row, group?.id || ''),
    },
    el('span', { class: 'sess-htop' },
      el('span', { class: 'sess-htitle', text: title }),
      row.pinned && st.histMode === 'file' && scopeMode() !== 'global'
        ? el('span', { class: 'sess-hpin', title: tr('置顶'), 'aria-label': tr('置顶'), html: ICONS.pin }) : null),
    meta ? el('span', { class: 'sess-hmeta', text: meta }) : null),
    el('button', {
      type: 'button', class: 'sess-hmore', title: tr('更多操作'), 'aria-label': tr('更多操作'),
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: event => { event.stopPropagation(); openHistoryMenu(row, event.currentTarget); },
      onkeydown: event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        event.stopPropagation();
        openHistoryMenu(row, event.currentTarget);
        if (event.key === 'ArrowUp') st.historyMenu?.panel.querySelector('[role="menuitem"]:last-child')?.focus({ preventScroll: true });
      },
    }, el('span', { html: ICONS.more }), el('span', { text: tr('更多') })),
  );
  return wrap;
}

function startRename(sid) {
  st.renameSid = sid;
  renderHistoryList();
}

async function confirmDeleteRow(row) {
  if (!guardBusy(tr("删除会话"))) return;
  const fileKey = keyForRow(row);
  const title = row.title || (row.count ? tr("（无标题会话）") : tr("新会话"));
  const ok = await sessionsConfirm({
    title: tr("删除这个会话？"),
    body: tr("「{0}」的对话和 AI 功能记录会被删除；论文、笔记、译文都不受影响，删除后不可恢复。", title),
    okText: tr("删除会话"),
    danger: true,
  });
  if (!ok) return;
  try {
    if (!await st.ctx.deleteSession(row.sid, fileKey)) return;
    await refreshList({ force: true });
    if (st.entryVisible) renderEntryCard(activeRows()[0] || null);
    if (st.historyOpen) renderHistoryList();
    if (st.quickOpen) renderQuickList();
    renderMemoryBtn();
    renderHeader();
  } catch (e) {
    toast(tr("删除失败：{0}", e.message), 'err', 4200);
  }
}

async function clearCurrent() {
  if (!guardBusy(tr("清空会话"))) return;
  const ok = await sessionsConfirm({
    title: tr("清空当前会话？"),
    body: tr("当前会话里的问答和 AI 功能记录会清空（会话本身保留）；译文不属于会话，不会被清空。"),
    okText: tr("清空"),
    danger: true,
  });
  if (!ok) return;
  await st.ctx.clearCurrentSession();
  await refreshList({ force: true });
  if (st.historyOpen) renderHistoryList();
  renderHeader();
}

/* ───────────────────────────── 应用内确认框 ───────────────────────────── */

function ensureConfirm() {
  if (st.ui.confirmMask) return;
  const mask = el('div', { class: 'sess-confirm-mask hidden', role: 'dialog', 'aria-modal': 'true' });
  const title = el('div', { class: 'sess-confirm-title' });
  const body = el('div', { class: 'sess-confirm-body' });
  const ok = el('button', { type: 'button', class: 'sess-confirm-btn danger', text: tr("确定") });
  const cancel = el('button', { type: 'button', class: 'sess-confirm-btn ghost', text: tr("取消") });
  ok.addEventListener('click', () => resolveConfirm(true));
  cancel.addEventListener('click', () => resolveConfirm(false));
  mask.addEventListener('click', (e) => { if (e.target === mask) resolveConfirm(false); });
  const card = el('div', { class: 'sess-confirm', role: 'document' },
    title, body, el('div', { class: 'sess-confirm-acts' }, cancel, ok));
  mask.append(card);
  document.body.append(mask);
  st.ui.confirmMask = mask;
  st.ui.confirmTitle = title;
  st.ui.confirmBody = body;
  st.ui.confirmOk = ok;
  st.ui.confirmCancel = cancel;
}

function resolveConfirm(ok) {
  const mask = st.ui?.confirmMask;
  if (!mask) return;
  mask.classList.add('hidden');
  const fn = st.confirmResolve;
  st.confirmResolve = null;
  if (fn) fn(!!ok);
}

export function sessionsConfirm({ title = tr("确认"), body = '', okText = tr("确定"), cancelText = tr("取消"), danger = false } = {}) {
  if (st.confirmResolve) resolveConfirm(false);
  ensureConfirm();
  st.ui.confirmTitle.textContent = title;
  st.ui.confirmBody.textContent = body;
  st.ui.confirmOk.textContent = okText;
  st.ui.confirmOk.classList.toggle('danger', !!danger);
  st.ui.confirmCancel.textContent = cancelText;
  st.ui.confirmMask.classList.remove('hidden');
  st.ui.confirmOk.focus();
  return new Promise((resolve) => { st.confirmResolve = resolve; });
}

/* ───────────────────────────── 文件夹改名 / 移动迁移 ───────────────────────────── */

/** 把 localStorage reader.activeSession 里旧文件夹键的当前会话挪到新键 */
function migrateActiveSessionKey(fromKey, toKey) {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    const map = raw ? JSON.parse(raw) : null;
    if (!map || typeof map !== 'object') return;
    if (!map[fromKey]) return;
    map[toKey] = map[fromKey];
    delete map[fromKey];
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

/** app.js 在文件夹改名/拖动成功后调用：复制会话文件 + 附件到新 folderKey，并迁移当前会话指针 */
export async function sessionsMigrateFolder(fromPath, toPath) {
  if (!st.ctx) return;
  const fromKey = st.ctx.folderKeyOf(fromPath || '');
  const toKey = st.ctx.folderKeyOf(toPath || '');
  if (!fromKey || !toKey || fromKey === toKey) return;
  try {
    const r = await fetch('/api/sessions/move-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromKey, toKey, toPath: toPath || '' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(errorOf(j, r));
    migrateActiveSessionKey(fromKey, toKey);
    if (st.folderPath === (fromPath || '') || st.folderPath.startsWith(`${fromPath || ''}/`)) {
      await sessionsOnFolderRenamed();
    }
  } catch (e) {
    toast(tr("会话迁移失败：{0}（旧文件夹下的会话文件已保留）", e.message), 'err', 5200);
  }
}

/** 文件夹改名/移动后：app.js 已更新 state.currentFolder，这里刷新缓存列表 */
export async function sessionsOnFolderRenamed() {
  if (!st.ctx?.hasDoc?.()) return;
  st.folderPath = st.ctx.folderPath();
  st.folderKey = st.ctx.folderKey();
  st.listLoaded = false;
  await refreshList({ force: true });
}

/* ───────────────────────────── 按键 / 快捷键 ───────────────────────────── */

function isTypingTarget(t) {
  const tag = (t?.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || !!t?.isContentEditable;
}

function onKeydownCapture(e) {
  if (st.historyMenu && (e.ctrlKey || e.metaKey) && ['+', '=', '-', '_', '0'].includes(e.key)) {
    // Let the workspace handle its zoom shortcut after dismissing this anchored menu.
    closeHistoryMenu({ focus: true });
  }
  // 确认框优先
  if (st.confirmResolve) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); resolveConfirm(false); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); resolveConfirm(true); }
    return;
  }
  if (e.key === 'Escape') {
    if (st.historyMenu) { e.preventDefault(); e.stopPropagation(); closeHistoryMenu({ focus: true }); return; }
    if (st.renameSid !== null && e.target?.matches?.('.sess-rename-input')) return;
    if (st.moveUi?.isOpen()) { e.preventDefault(); e.stopPropagation(); st.moveUi.close(); return; }
    if (st.quickOpen) {
      e.preventDefault(); e.stopPropagation();
      if (st.ui.quick.querySelector('#sessQuickMore')?.getAttribute('aria-expanded') === 'true') setQuickMore(false, { focus: true });
      else closeQuick({ focus: true });
      return;
    }
    if (st.historyOpen) { e.preventDefault(); e.stopPropagation(); closeHistory(); return; }
  }
  if (st.historyOpen && e.key === 'F2' && st.renameSid == null && !isTypingTarget(e.target)) {
    const row = e.target?.closest?.('.sess-hrow') || st.historyMenu?.trigger.closest('.sess-hrow');
    if (!row) return;
    e.preventDefault(); e.stopPropagation();
    startRename(row.dataset.sid);
    return;
  }
}

/* 快捷键：Ctrl/⌘+Shift+N/H（浏览器里 Ctrl+Shift+N 会被无痕窗口占用，再补 Ctrl+Alt+N/H） */
function onGlobalShortcut(e) {
  if (!st.ctx?.hasDoc?.()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = String(e.key || '').toLowerCase();
  if (key === 'n' && (e.shiftKey || e.altKey) && !(e.shiftKey && e.altKey)) {
    e.preventDefault(); e.stopPropagation();
    doNewSession();
  } else if (key === 'h' && (e.shiftKey || e.altKey) && !(e.shiftKey && e.altKey)) {
    e.preventDefault(); e.stopPropagation();
    toggleHistory();
  }
}

export function sessionsShortcutNew() { doNewSession(); }
export function sessionsShortcutHistory() { toggleHistory(); }

/* ───────────────────────────── 初始化 ───────────────────────────── */

export function initSessions(ctx) {
  st.ctx = ctx;
  const ui = st.ui = {
    rightSide: $('#rightSide'),
    bar: $('#sessBar'),
    btn: $('#sessBtn'),
    label: $('#sessLabel'),
    dot: $('#sessDot'),
    newBtn: $('#sessNew'),
    histBtn: $('#sessHist'),
    quick: $('#sessQuickPop'),
    history: $('#sessHistory'),
    menu: $('#sessionMenu'),
    entry: null,
    confirmMask: null,
  };
  if (!ui.bar) return;
  st.moveUi = createSessionMove({
    host: ui.rightSide,
    getContext: () => st.ctx,
    canMove: () => guardBusy(tr('移动会话')),
    onMoved: async () => {
      await refreshList({ force: true, allowWithoutDoc: true });
      if (!st.historyOpen) st.allList = [];
    },
  });

  // 进文件夹选择卡片：由本模块创建，app.js 的 renderCol 在 chat 栏优先挂它
  ui.entry = el('section', {
    class: 'entry-card hidden',
    id: 'sessEntryCard',
    dataset: { show: '0' },
    'aria-label': tr("选择进入哪个会话"),
  });

  buildHistory();

  ui.newBtn?.addEventListener('click', (e) => { e.stopPropagation(); doNewSession(); });
  ui.histBtn?.addEventListener('click', (e) => { e.stopPropagation(); toggleHistory(); });
  ui.bar.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', () => { if (st.quickOpen) closeQuick(); });
  document.addEventListener('pointerdown', event => {
    const menu = st.historyMenu;
    if (menu && !menu.panel.contains(event.target) && !menu.trigger.contains(event.target)) closeHistoryMenu();
  }, true);
  document.addEventListener('focusin', event => {
    const menu = st.historyMenu;
    if (menu && !menu.panel.contains(event.target) && !menu.trigger.contains(event.target)) closeHistoryMenu();
  });
  document.addEventListener('scroll', event => {
    if (st.historyMenu && !st.historyMenu.panel.contains(event.target)) closeHistoryMenu();
  }, true);
  window.addEventListener('resize', () => closeHistoryMenu());
  if (ui.rightSide) new ResizeObserver(() => closeHistoryMenu()).observe(ui.rightSide);
  document.addEventListener('keydown', onKeydownCapture, true);
  document.addEventListener('keydown', onGlobalShortcut);

  // 选择卡片换了文档/文件夹后不再显示
  st.currentSid = st.ctx.currentSid?.() || '';
  renderHeader();
}

/* 供 app.js 判断「当前是不是选择卡片模式」 */
export function sessionsIsEntryMode() {
  return !!st.entryVisible;
}

/** app.js 在历史面板里跨文件夹打开会话时用：openDoc 会按「进入方式」重新亮出选择卡片，
 *  用户已经点名要哪个会话，先收起来，再切过去。 */
export function sessionsHideEntryCard() {
  if (!st.entryVisible) return;
  hideEntryCard();
}

/** 选择卡片节点（app.js 的 renderCol 用它挂进 #aiArea；不能用 getElementById，卡片在切换面板时会脱离文档） */
export function sessionsEntryCardEl() {
  return st.ui?.entry || null;
}

/** 选择卡片模式下用户直接往输入框发送：先偷偷建一个新会话，再照常发送 */
export async function sessionsLeaveEntryForNewSession() {
  if (!st.entryVisible) return true;
  if (st.busy || st.ctx?.isBusy?.()) return false;
  hideEntryCard();
  await st.ctx.startNewSession({ silent: true, fromEntry: true });
  return true;
}

/** app.js 在「解释」这类旁路输出前调用：当前还停在选择会话卡片上（没有活动会话）时，
 *  先打开最近的会话，再让调用方把结果写进那段对话。一个会话都没有就静默新建一个空会话。
 *  返回 true 表示已经有一个可以写入的活动会话。 */
export async function sessionsOpenLatestForOutput() {
  if (!st.entryVisible) return true;
  if (st.busy || st.ctx?.isBusy?.()) return false;
  if (!st.ctx?.hasDoc?.()) return false;
  await refreshList({ force: true });
  const docId = String(st.ctx.doc()?.docId || st.docId || '');
  // 「最近」按最后活动时间算（置顶只影响历史排序，不代表最近用过）；优先挑读过当前论文的那段
  const rows = st.list
    .filter((r) => !r.archived && (r.count || 0) > 0)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const row = rows.find((r) => Array.isArray(r.docIds) && r.docIds.map(String).includes(docId))
    || rows[0] || null;
  hideEntryCard();
  if (row) await st.ctx.openSessionFromHistory(row, { force: true });
  else await st.ctx.startNewSession({ silent: true, fromEntry: true });
  return true;
}

/** 设置页「会话」分类用：进入文件夹默认方式 / 历史默认排列 */
export function sessionsGetEnterMode() { return readOnEnter(); }
export function sessionsSetEnterMode(mode) {
  setOnEnter(mode === 'resume' || mode === 'new' ? mode : 'choose');
}
export function sessionsGetHistoryMode() { return readHistMode(); }
export function sessionsSetHistoryMode(mode) {
  const next = mode === 'time' ? 'time' : 'file';
  st.histMode = next;
  try { localStorage.setItem(HIST_MODE_KEY, next); } catch { /* ignore */ }
  if (!st.historyOpen) return;
  st.ui?.history?.querySelectorAll('.sess-arrange-chip').forEach((b) => {
    const on = b.dataset.mode === next;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  renderHistoryList();
}

/** AI 自动标题完成后由 app.js 调用：就地更新头部/快切/历史行，不重新拉网络 */
export function sessionsApplyMeta(sid, patch) {
  if (!sid || !patch) return;
  for (const arr of [st.list, st.allList]) {
    for (const row of arr) if (row.sid === sid) Object.assign(row, patch);
  }
  if (st.ctx?.hasDoc?.()) renderHeader();
  if (st.quickOpen) renderQuickList();
  if (st.historyOpen) renderHistoryList();
}

/** 给 app.js 用：当前文件夹的会话列表（loadPaperMemory 等复用） */
export function sessionsGetList() {
  return st.list;
}

/** app.js 在文件夹改名/移动后调：更新缓存中的文件夹路径 */
export function sessionsOnFolderEntered(path) {
  st.moveUi?.close({ focus: false, force: true });
  st.folderPath = String(path || '');
  st.folderKey = st.ctx?.folderKeyOf ? st.ctx.folderKeyOf(st.folderPath) : '';
  st.docId = '';
  st.list = [];
  st.allList = [];
  st.listLoaded = false;
  st.currentSid = '';
  st.renameSid = null;
  st.histQuery = '';
  st.quickQuery = '';
  st.entryVisible = false;
  if (st.ui?.entry) {
    st.ui.entry.dataset.show = '0';
    st.ui.entry.classList.add('hidden');
  }
  closeQuick();
  closeHistory();
  renderHeader();
}
