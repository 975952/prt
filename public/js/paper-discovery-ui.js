import { t as tr } from './i18n.js';
import { el } from './util.js';
import { iconEl } from './icons.js';

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value, max = 500) => typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : '';
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1000000, Math.floor(Number(value)))) : 0;
const texts = (value, limit = 8, length = 180) => [...new Set((Array.isArray(value) ? value : []).map(item => text(item, length)).filter(Boolean))].slice(0, limit);
const authors = row => texts(Array.isArray(row.authors) ? row.authors : [row.authors || row.author], 5, 160);
const year = value => /^\d{4}$/.test(String(value || '')) ? String(value) : '';
function paperTitle(row) {
  const title = (row.title || row.name || row.path.split('/').at(-1) || '').replace(/\.pdf$/i, '').trim();
  return title.replace(/^(?:arxiv\s*:?\s*)?\d{4}\.\d{4,5}(?:v\d+)?\s*[-_·:]\s*/i, '')
    .replace(/^\[\d{1,4}\]\s*/, '').replace(/^\d{1,3}\s*[-_]\s+/, '') || title;
}
function localRows(values) {
  const rows = [], keys = new Set();
  for (const value of (Array.isArray(values) ? values : []).slice(0, 48)) {
    const row = record(value), path = text(row.path, 500), docId = text(row.docId, 240);
    const name = text(row.name, 300), title = text(row.title, 500) || name || path.split('/').at(-1);
    const key = path || docId;
    if (!key || !title || keys.has(key)) continue;
    keys.add(key);
    rows.push({ path, docId, name, title, folder: text(row.folder, 500), authors: authors(row), year: year(row.year),
      page: Number.isSafeInteger(row.page) && row.page > 0 && row.page <= 100000 ? row.page : null,
      snippet: text(row.snippet, 900), matchKind: text(row.matchKind, 40), relation: ['identity', 'topic'].includes(row.relation) ? row.relation : '' });
    if (rows.length >= 8) break;
  }
  return rows;
}
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
  const textIncomplete = Math.min(total, count(coverage.textIncomplete));
  const remaining = Math.min(total, Math.max(count(coverage.remaining), total - checked - unreadable));
  const results = [], onlineKeys = new Set();
  for (const value of (Array.isArray(online.results) ? online.results : []).slice(0, 24)) {
    const row = record(value), title = text(row.title, 500);
    const url = externalUrl(row.url), pdfUrl = externalUrl(row.pdfUrl), key = url || pdfUrl;
    if (!title || !key || onlineKeys.has(key)) continue;
    onlineKeys.add(key);
    results.push({ title, url, pdfUrl, year: year(row.year), authors: authors(row),
      source: text(row.source, 100), snippet: text(row.snippet, 900) });
    if (results.length >= 8) break;
  }
  return {
    query: text(raw.query, 1000), mode: ['auto', 'known', 'topic'].includes(raw.mode) ? raw.mode : 'auto',
    titles: texts(raw.titles), aliases: texts(raw.aliases), keywords: texts(raw.keywords, 12),
    local: { matches: localRows(local.matches), relatedMatches: localRows(local.relatedMatches), referenceMatches: localRows(local.referenceMatches),
      status: text(local.status, 40), error: text(local.error, 500),
      coverage: { total, checked, unreadable, remaining, textIncomplete,
        complete: coverage.complete === true && checked >= total && !unreadable && !remaining && !textIncomplete } },
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
  function cards(rows, render) {
    const list = el('div', { class: 'paper-discovery-list' });
    rows.slice(0, 4).forEach(row => list.append(render(row)));
    if (rows.length > 4) list.append(el('details', { class: 'paper-discovery-more' },
      el('summary', { text: tr('另外 {0} 篇', rows.length - 4) }),
      el('div', { class: 'paper-discovery-list' }, rows.slice(4).map(render))));
    return list;
  }
  function localCard(row) {
    const item = el('div', { class: 'paper-discovery-item' });
    const title = paperTitle(row), duplicate = local.matches.filter(value => paperTitle(value).toLowerCase() === title.toLowerCase()).length > 1;
    const folder = row.folder || row.path.split('/').slice(0, -1).join('/');
    const bibliography = [row.authors.length ? row.authors.slice(0, 2).join(', ') + (row.authors.length > 2 ? ' et al.' : '') : '', row.year].filter(Boolean).join(' · ');
    const context = [bibliography, duplicate ? folder || tr('书架根目录') : bibliography ? '' : folder].filter(Boolean).join(' · ');
    const copy = el('span', { class: 'paper-discovery-copy' }, el('span', { class: 'paper-discovery-title', text: title }));
    if (context) copy.append(el('span', { class: 'paper-discovery-meta', text: context, title: context }));
    const arrow = el('span', { class: 'paper-discovery-arrow', 'aria-hidden': 'true' }, iconEl('chevron-right'));
    const card = el('button', { type: 'button', class: 'paper-discovery-card paper-discovery-local',
      dataset: { paperPath: row.path, paperDocId: row.docId },
      'aria-label': tr('打开论文：{0}', [title, duplicate ? folder || tr('书架根目录') : ''].filter(Boolean).join(' · ')) }, copy, arrow);
    card.disabled = typeof onOpenPaper !== 'function';
    card.addEventListener('click', async () => {
      if (card.disabled) return;
      card.disabled = true; card.setAttribute('aria-busy', 'true');
      arrow.replaceChildren(iconEl('refresh')); item.querySelector('.paper-discovery-error')?.remove();
      try { await onOpenPaper(row); }
      catch (error) { failure(item, error); }
      finally { card.disabled = false; card.removeAttribute('aria-busy'); arrow.replaceChildren(iconEl('chevron-right')); }
    });
    item.append(card);
    return item;
  }
  function link(label, url) {
    return el('a', { class: 'paper-discovery-action', href: url, target: '_blank', rel: 'noopener noreferrer', text: label }, iconEl('link'));
  }
  function onlineCard(row) {
    const card = el('article', { class: 'paper-discovery-card paper-discovery-online' });
    let host = '';
    try { host = new URL(row.url || row.pdfUrl).hostname.replace(/^www\./, ''); } catch { /* Normalized above. */ }
    const source = el('a', { class: 'paper-discovery-source', href: row.url || row.pdfUrl, target: '_blank', rel: 'noopener noreferrer',
      'aria-label': tr('查看论文来源：{0}', row.title) },
      el('span', { class: 'paper-discovery-copy' }, el('span', { class: 'paper-discovery-title', text: row.title }),
        el('span', { class: 'paper-discovery-meta', text: [row.year, row.source || host].filter(Boolean).join(' · ') })),
      el('span', { class: 'paper-discovery-arrow', 'aria-hidden': 'true' }, iconEl('link')));
    card.append(source);
    const actions = el('div', { class: 'paper-discovery-actions' });
    if (row.pdfUrl) {
      if (row.url && row.url !== row.pdfUrl) actions.append(link(tr('打开 PDF 链接'), row.pdfUrl));
      if (typeof onImport === 'function') actions.append(action(tr('导入书架'), tr('正在导入…'), onImport, card, row, result));
    }
    if (actions.childElementCount) card.append(actions);
    return card;
  }

  const localSection = el('div', { class: 'paper-discovery-section' });
  const coverage = local.coverage;
  const searching = ['loading', 'searching'].includes(local.status);
  if (local.matches.length) {
    localSection.append(cards(local.matches, localCard));
  }
  else if (searching) {
    localSection.append(el('p', { class: 'paper-discovery-empty', role: 'status', text: tr('正在查找书架中的论文…') }));
  } else if (!online.results.length) {
    localSection.append(el('p', { class: 'paper-discovery-empty', text: local.error || (coverage.complete
      ? tr('本次书架检索没有找到匹配论文。') : tr('目前没有找到匹配论文，仍有内容未能核实。')) }));
    const coverageParts = [tr('已检查 {0} / {1} 篇论文', coverage.checked, coverage.total)];
    if (coverage.unreadable) coverageParts.push(tr('{0} 篇暂时无法读取', coverage.unreadable));
    if (coverage.textIncomplete) coverageParts.push(tr('{0} 篇含未能核实的内容', coverage.textIncomplete));
    if (coverage.remaining) coverageParts.push(tr('{0} 篇尚未检查', coverage.remaining));
    if (coverage.total) localSection.append(el('details', { class: 'paper-discovery-more paper-discovery-coverage' },
      el('summary', { text: tr('检索范围') }), el('p', { class: 'paper-discovery-note', text: coverageParts.join(' · ') })));
  }
  if (localSection.childElementCount) root.append(localSection);

  if (online.results.length || (!local.matches.length && ['loading', 'complete', 'partial', 'failed'].includes(online.status))) {
    const section = el('div', { class: 'paper-discovery-section' });
    if (online.results.length) section.append(cards(online.results, onlineCard));
    if (online.status === 'loading') section.append(el('p', { class: 'paper-discovery-empty', role: 'status', text: tr('正在查找网络论文…') }));
    else if (online.status === 'failed') section.append(el('p', { class: 'paper-discovery-error', role: 'status', text: tr('网络检索暂时不可用，可以稍后重试。') }));
    else if (online.status === 'partial') section.append(el('p', { class: 'paper-discovery-note', text: tr('部分来源暂时不可用，已找到的论文仍可查看。') }));
    else if (online.status === 'complete' && !online.results.length) section.append(el('p', { class: 'paper-discovery-empty', text: tr('暂未找到可核实的网络论文，可以补充标题、作者或关键词。') }));
    if (!local.matches.length && ['failed', 'partial'].includes(online.status) && typeof onFindOnline === 'function') section.append(
      action(tr('重试联网查找'), tr('正在查找…'), onFindOnline, section, result));
    root.append(section);
  } else if (!local.matches.length && !searching && typeof onFindOnline === 'function') {
    const footer = el('div', { class: 'paper-discovery-footer' });
    if (online.status === 'blocked') footer.append(el('p', { class: 'paper-discovery-note', text: tr('本轮未开启联网；点击后仅为这次查找联网。') }));
    footer.append(action(tr('继续联网查找'), tr('正在查找…'), onFindOnline, footer, result));
    root.append(footer);
  }
  return root;
}
