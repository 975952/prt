import { t as tr } from './i18n.js';
import { el } from './util.js';
import { iconEl } from './icons.js';

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value, max = 500) => typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : '';
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1000000, Math.floor(Number(value)))) : 0;
function externalUrl(value) {
  const input = text(value, 2000);
  if (!/^https?:\/\//i.test(input) || /[\u0000-\u0020\u007f]/.test(input)) return '';
  try {
    const url = new URL(input);
    return url.username || url.password ? '' : url.href;
  } catch { return ''; }
}

/** Bounded, data-only cards. Unknown fields and executable URLs never survive storage. */
export function normalizePaperDiscovery(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const local = record(raw.local), online = record(raw.online), coverage = record(local.coverage);
  const total = count(coverage.total), checked = Math.min(total, count(coverage.checked));
  const unreadable = Math.min(total, count(coverage.unreadable));
  const remaining = Math.min(total, Math.max(count(coverage.remaining), total - checked - unreadable));
  const matches = [], localKeys = new Set();
  for (const value of (Array.isArray(local.matches) ? local.matches : []).slice(0, 48)) {
    const row = record(value);
    const path = text(row.path, 500), docId = text(row.docId, 240);
    const name = text(row.name, 300), title = text(row.title, 500) || name || path;
    const key = path || docId;
    if (!key || !title || localKeys.has(key)) continue;
    localKeys.add(key);
    matches.push({ path, docId, name, title, folder: text(row.folder, 500),
      page: Number.isSafeInteger(row.page) && row.page > 0 && row.page <= 100000 ? row.page : null,
      snippet: text(row.snippet, 900), matchKind: text(row.matchKind, 40) });
    if (matches.length >= 8) break;
  }
  const results = [], onlineKeys = new Set();
  for (const value of (Array.isArray(online.results) ? online.results : []).slice(0, 24)) {
    const row = record(value), title = text(row.title, 500);
    const url = externalUrl(row.url), pdfUrl = externalUrl(row.pdfUrl), key = url || pdfUrl;
    if (!title || !key || onlineKeys.has(key)) continue;
    onlineKeys.add(key);
    results.push({ title, url, pdfUrl, year: /^\d{4}$/.test(String(row.year || '')) ? String(row.year) : '',
      source: text(row.source, 100), snippet: text(row.snippet, 900) });
    if (results.length >= 8) break;
  }
  return {
    query: text(raw.query, 1000),
    local: { matches, status: text(local.status, 40), error: text(local.error, 500),
      coverage: { total, checked, unreadable, remaining,
        complete: coverage.complete === true && checked >= total && !unreadable && !remaining } },
    online: { status: ['idle', 'blocked', 'loading', 'complete', 'partial', 'failed'].includes(online.status) ? online.status : 'idle',
      results, error: text(online.error, 500) },
  };
}

/** The caller owns search, import, navigation and persistence; this surface only renders a snapshot. */
export function renderPaperDiscovery(raw, { onOpenPaper, onFindOnline, onImport, onError } = {}) {
  const result = normalizePaperDiscovery(raw);
  if (!result) return el('div', { class: 'paper-discovery', hidden: true });
  const root = el('section', { class: 'paper-discovery', 'aria-label': tr('论文查找结果') });
  const { local, online } = result;
  if (result.query) root.append(el('div', { class: 'paper-discovery-query', text: result.query, title: result.query }));

  function failure(host, error) {
    let node = host.querySelector('.paper-discovery-error');
    if (!node) { node = el('p', { class: 'paper-discovery-error', role: 'alert' }); host.append(node); }
    node.textContent = String(error?.message || tr('操作失败，请重试。')).slice(0, 500);
    if (typeof onError === 'function') {
      try { onError(error); } catch { /* Local feedback remains available. */ }
    }
  }
  function action(label, busyLabel, callback, host, ...args) {
    const caption = el('span', { text: label });
    const button = el('button', { type: 'button', class: 'paper-discovery-action' }, caption);
    if (typeof callback !== 'function') button.disabled = true;
    button.addEventListener('click', async () => {
      if (button.disabled || typeof callback !== 'function') return;
      button.disabled = true; caption.textContent = busyLabel; button.setAttribute('aria-busy', 'true');
      host.querySelector('.paper-discovery-error')?.remove();
      try { await callback(...args); }
      catch (error) { failure(host, error); }
      finally { button.disabled = false; caption.textContent = label; button.removeAttribute('aria-busy'); }
    });
    return button;
  }
  function heading(label, total, icon) {
    return el('div', { class: 'paper-discovery-heading' }, iconEl(icon),
      el('span', { text: label }), total ? el('span', { class: 'paper-discovery-count', text: String(total) }) : null);
  }
  function cards(rows, render) {
    const list = el('div', { class: 'paper-discovery-list' });
    rows.slice(0, 4).forEach(row => list.append(render(row)));
    if (rows.length > 4) list.append(el('details', { class: 'paper-discovery-more' },
      el('summary', { text: tr('另外 {0} 篇', rows.length - 4) }),
      el('div', { class: 'paper-discovery-list' }, rows.slice(4).map(render))));
    return list;
  }
  function localCard(row) {
    const card = el('article', { class: 'paper-discovery-card', dataset: { paperPath: row.path, paperDocId: row.docId } });
    const context = [row.folder || tr('书架根目录'), row.page ? tr('第 {0} 页', row.page) : ''].filter(Boolean).join(' · ');
    card.append(el('div', { class: 'paper-discovery-title', text: row.title }),
      el('div', { class: 'paper-discovery-meta', text: context, title: context }));
    if (row.snippet) card.append(el('p', { class: 'paper-discovery-snippet', text: row.snippet }));
    const open = action(row.page ? tr('打开第 {0} 页', row.page) : tr('打开论文'), tr('正在打开…'), onOpenPaper, card, row);
    open.classList.add('paper-discovery-primary');
    open.append(iconEl('chevron-right'));
    card.append(el('div', { class: 'paper-discovery-actions' }, open));
    return card;
  }
  function link(label, url) {
    return el('a', { class: 'paper-discovery-action', href: url, target: '_blank', rel: 'noopener noreferrer', text: label }, iconEl('link'));
  }
  function onlineCard(row) {
    const card = el('article', { class: 'paper-discovery-card' });
    let host = '';
    try { host = new URL(row.url || row.pdfUrl).hostname.replace(/^www\./, ''); } catch { /* Normalized above. */ }
    card.append(el('div', { class: 'paper-discovery-title', text: row.title }),
      el('div', { class: 'paper-discovery-meta', text: [row.year, row.source || host].filter(Boolean).join(' · ') }));
    if (row.snippet) card.append(el('p', { class: 'paper-discovery-snippet', text: row.snippet }));
    const actions = el('div', { class: 'paper-discovery-actions' });
    if (row.url) actions.append(link(tr('查看来源'), row.url));
    if (row.pdfUrl) {
      actions.append(link(tr('打开 PDF 链接'), row.pdfUrl));
      if (typeof onImport === 'function') actions.append(action(tr('导入书架'), tr('正在导入…'), onImport, card, row, result));
    }
    card.append(actions);
    return card;
  }

  const localSection = el('div', { class: 'paper-discovery-section' }, heading(tr('本地书架'), local.matches.length, 'book'));
  const coverage = local.coverage;
  const coverageParts = [coverage.complete ? tr('已检查书架中的 {0} 篇论文', coverage.total)
    : tr('已检查 {0} / {1} 篇论文', coverage.checked, coverage.total)];
  if (coverage.unreadable) coverageParts.push(tr('{0} 篇暂时无法读取', coverage.unreadable));
  if (coverage.remaining) coverageParts.push(tr('{0} 篇尚未检查', coverage.remaining));
  localSection.append(el('p', { class: 'paper-discovery-coverage', text: coverageParts.join(' · ') }));
  if (local.matches.length) {
    localSection.append(cards(local.matches, localCard));
    if (!coverage.complete) localSection.append(el('p', { class: 'paper-discovery-note paper-discovery-unverified', text: tr('仍有内容未能核实，书架中可能还有其他相关论文。') }));
  }
  else if (local.status === 'loading' || local.status === 'searching') {
    localSection.append(el('p', { class: 'paper-discovery-empty', role: 'status', text: tr('正在查找书架中的论文…') }));
  } else {
    localSection.append(el('p', { class: 'paper-discovery-empty', text: local.error || (coverage.complete
      ? tr('本次书架检索没有找到匹配论文。') : tr('目前没有找到匹配论文，仍有内容未能核实。')) }));
  }
  root.append(localSection);

  if (['loading', 'complete', 'partial', 'failed'].includes(online.status) || online.results.length) {
    const section = el('div', { class: 'paper-discovery-section' }, heading(tr('网络论文'), online.results.length, 'search'));
    if (online.results.length) section.append(cards(online.results, onlineCard));
    if (online.status === 'loading') section.append(el('p', { class: 'paper-discovery-empty', role: 'status', text: tr('正在查找网络论文…') }));
    else if (online.status === 'failed') section.append(el('p', { class: 'paper-discovery-error', role: 'status', text: tr('网络检索暂时不可用，可以稍后重试。') }));
    else if (online.status === 'partial') section.append(el('p', { class: 'paper-discovery-note', text: tr('部分来源暂时不可用，已找到的论文仍可查看。') }));
    else if (online.status === 'complete' && !online.results.length) section.append(el('p', { class: 'paper-discovery-empty', text: tr('暂未找到可核实的网络论文，可以补充标题、作者或关键词。') }));
    if (['failed', 'partial'].includes(online.status) && typeof onFindOnline === 'function') section.append(
      action(tr('重试联网查找'), tr('正在查找…'), onFindOnline, section, result));
    root.append(section);
  } else if (typeof onFindOnline === 'function') {
    const footer = el('div', { class: 'paper-discovery-footer' });
    if (online.status === 'blocked') footer.append(el('p', { class: 'paper-discovery-note', text: tr('本轮未开启联网；点击后仅为这次查找联网。') }));
    if (!coverage.complete) footer.append(el('p', { class: 'paper-discovery-note', text: tr('也可以继续联网查找；这不代表本地书架中没有。') }));
    footer.append(action(tr('继续联网查找'), tr('正在查找…'), onFindOnline, footer, result));
    root.append(footer);
  }
  return root;
}
