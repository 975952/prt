import { el } from './util.js';
import { t as tr } from './i18n.js';

const validPage = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const roundCoordinate = value => Math.round(value * 1000000) / 1000000;

// PDF selections use coordinates relative to the unscaled page. Keep only those
// numbers in session data, never a DOM range or a screen position.
export function translationGeometry(source) {
  const rectsByPage = {};
  let remaining = 800;
  for (const [page, rectangles] of Object.entries(source?.rectsByPage || {})) {
    if (!validPage(page) || !Array.isArray(rectangles) || !remaining) continue;
    const rects = [];
    for (const rect of rectangles) {
      if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) continue;
      const { x, y, w, h } = rect;
      if (x < 0 || y < 0 || x >= 1 || y >= 1 || w <= 0 || h <= 0) continue;
      rects.push({ x: roundCoordinate(x), y: roundCoordinate(y),
        w: roundCoordinate(Math.min(w, 1 - x)), h: roundCoordinate(Math.min(h, 1 - y)) });
      if (!--remaining) break;
    }
    if (rects.length) rectsByPage[page] = rects;
  }
  if (!Object.keys(rectsByPage).length) return {};
  const result = { rectsByPage };
  const start = source?.readingStart;
  if (validPage(start?.page) && rectsByPage[start.page] && Number.isSafeInteger(start.run) && start.run >= 0
    && Number.isSafeInteger(start.offset) && start.offset >= 0) {
    result.readingStart = { page: Number(start.page), run: start.run, offset: start.offset };
  }
  return result;
}

function comparePosition(a, b) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return a.page - b.page || a.precision - b.precision || a.order - b.order || a.offset - b.offset;
}

function locations(record) {
  const retry = record.retry || {};
  const parts = Array.isArray(retry.segments) && retry.segments.length ? retry.segments : [{ ...retry, page: retry.page || record.page }];
  const result = [];
  for (const [segment, part] of parts.entries()) {
    if (!part || (part.docId && record.docId && part.docId !== record.docId)) continue;
    const { rectsByPage, readingStart } = translationGeometry(part);
    const pages = new Set([...Object.keys(rectsByPage || {}).map(Number), ...(Array.isArray(part.pages) ? part.pages : []), part.page].filter(validPage).map(Number));
    for (const page of pages) {
      const rects = rectsByPage?.[page] || [];
      const first = rects[0];
      const start = readingStart?.page === page ? readingStart : null;
      result.push({ page, segment, rects, precision: start ? 0 : first ? 1 : 2,
        order: start?.run ?? first?.y ?? 0, offset: start?.offset ?? first?.x ?? 0,
        text: retry.kind === 'translate-shot' ? '' : part.text || record.quote || '' });
    }
  }
  return result.sort(comparePosition);
}

export function createTranslationAlignment({ getViewer, getBody, getDocId, isReady, jumpPage, fallback, showTranslation }) {
  const metadata = new WeakMap();
  const pointsByPage = new Map();
  let rows = [], active = null, jumpVersion = 0, paintFrame = 0;

  function highlightPage(entry, page) {
    entry.hlLayer.querySelectorAll('.translation-source-mark').forEach(node => node.remove());
    for (const pin of entry.pinLayer.querySelectorAll('.translation-pin')) {
      pin.classList.toggle('active', !!active && pin.dataset.translationId === active.__sessionRecord.id);
    }
    if (!isReady()) return;
    for (const point of metadata.get(active)?.points || []) {
      if (point.page !== page) continue;
      for (const rect of point.rects) {
        const node = el('span', { class: 'translation-source-mark' });
        Object.assign(node.style, { left: rect.x * entry.cssW + 'px', top: rect.y * entry.cssH + 'px',
          width: rect.w * entry.cssW + 'px', height: rect.h * entry.cssH + 'px' });
        entry.hlLayer.append(node);
      }
    }
  }
  function activate(row) {
    if (row === active) return;
    active?.classList.remove('translation-linked');
    active = row;
    row?.classList.add('translation-linked');
    for (const [page, entry] of getViewer()?.rendered || []) highlightPage(entry, page);
  }
  function bindHover(node, row) {
    node.addEventListener('pointerenter', () => activate(row));
    node.addEventListener('pointerleave', () => { if (active === row && !node.contains(document.activeElement)) activate(null); });
    node.addEventListener('focusin', () => activate(row));
    node.addEventListener('focusout', event => { if (!node.contains(event.relatedTarget) && active === row) activate(null); });
  }
  function paintPage(page) {
    const entry = getViewer()?.rendered.get(page);
    if (!entry?.pinLayer) return;
    entry.pinLayer.querySelectorAll('.translation-pin').forEach(node => node.remove());
    const pins = isReady() ? (pointsByPage.get(page) || []).map(({ row, point }) =>
      ({ row, number: metadata.get(row).number, top: point.rects[0].y * entry.cssH })) : [];
    // Keep adjacent passages independently clickable even when their first
    // lines share the same height (two columns or overlapping selections).
    pins.sort((a, b) => a.top - b.top || a.number - b.number);
    const spacing = Math.min(22, Math.max(1, (entry.cssH - 22) / Math.max(1, pins.length - 1)));
    let previous = -spacing;
    pins.forEach((pin, index) => {
      const top = Math.min(entry.cssH - 22 - (pins.length - index - 1) * spacing, Math.max(previous + spacing, pin.top - 6, 0));
      previous = top;
      const label = tr('查看译文 {0}', pin.number);
      const button = el('button', { type: 'button', class: 'translation-pin', title: label, 'aria-label': label, text: String(pin.number),
        dataset: { translationId: pin.row.__sessionRecord.id }, onclick: event => {
          event.stopPropagation(); showTranslation(pin.row); activate(pin.row);
        } });
      button.style.top = top + 'px';
      bindHover(button, pin.row);
      entry.pinLayer.append(button);
    });
    highlightPage(entry, page);
  }
  function schedulePaint() {
    if (paintFrame) return;
    paintFrame = requestAnimationFrame(() => {
      paintFrame = 0;
      for (const page of getViewer()?.rendered.keys() || []) paintPage(page);
    });
  }
  document.addEventListener('pdfview:page-rendered', event => paintPage(event.detail.page));

  function refresh() {
    rows = [...(getBody()?.children || [])].filter(row => metadata.has(row)
      && (!row.__sessionRecord.docId || row.__sessionRecord.docId === getDocId()));
    if (active && !rows.includes(active)) activate(null);
    pointsByPage.clear();
    rows.forEach((row, index) => {
      const data = metadata.get(row);
      data.number = index + 1;
      data.badge.textContent = String(data.number);
      for (const point of data.points) {
        if (!point.rects.length) continue;
        if (!pointsByPage.has(point.page)) pointsByPage.set(point.page, []);
        pointsByPage.get(point.page).push({ row, point });
      }
    });
    schedulePaint();
  }
  async function locate(row, segment = null) {
    const point = metadata.get(row)?.points.find(item => segment === null || item.segment === segment);
    if (!row || !point || !isReady() || !rows.includes(row)) return;
    const version = ++jumpVersion;
    activate(row);
    if (!point.rects.length) { fallback(row, point.page, point.text); return; }
    const viewer = getViewer();
    const pdf = viewer.pdf;
    await jumpPage(point.page);
    if (version !== jumpVersion || viewer.pdf !== pdf || !isReady() || !rows.includes(row)) return;
    const page = viewer.pageEls[point.page];
    if (!page || viewer.immersive) return;
    const box = page.getBoundingClientRect(), viewport = viewer.container.getBoundingClientRect();
    const offset = box.top - viewport.top + point.rects[0].y * box.height - viewport.height * .32;
    viewer.container.scrollBy({ top: offset, behavior: 'instant' });
  }
  function insert(body, row) {
    const points = locations(row.__sessionRecord);
    const badge = el('span', { class: 'translation-number' });
    const label = points.length ? tr('第{0}页', [...new Set(points.map(point => point.page))].join('、')) : tr('文本翻译');
    const header = el(points.length ? 'button' : 'div', { class: 'translation-position', type: points.length ? 'button' : null,
      title: points.length ? tr('定位原文') : null, onclick: points.length ? () => locate(row) : null },
    badge, el('span', { text: label }));
    row.prepend(header);
    metadata.set(row, { points, badge, number: 0 });
    bindHover(row, row);
    const next = [...body.children].find(other => metadata.has(other)
      && comparePosition(points[0], metadata.get(other).points[0]) <= 0);
    body.insertBefore(row, next || null);
    refresh();
  }
  function bindSourceHover(container) {
    let pending = null, frame = 0, hovered = null;
    function release() {
      pending = null;
      if (hovered && active === hovered) activate(null);
      hovered = null;
    }
    function sync() {
      frame = 0;
      if (!pending || !getBody()?.isConnected || !isReady()) { release(); return; }
      const { page, clientX, clientY } = pending;
      const box = page.getBoundingClientRect();
      const x = (clientX - box.left) / box.width, y = (clientY - box.top) / box.height;
      const hit = pointsByPage.get(Number(page.dataset.page))?.find(({ point }) =>
        point.rects.some(rect => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h));
      if (hit) { hovered = hit.row; activate(hit.row); }
      else release();
    }
    container.addEventListener('pointermove', event => {
      const page = event.target.closest('.page');
      if (event.target.closest('.translation-pin')) { pending = null; hovered = null; return; }
      if (event.pointerType !== 'mouse' || event.buttons || !page || event.target.closest('button') || !pointsByPage.size) {
        release(); return;
      }
      pending = { page, clientX: event.clientX, clientY: event.clientY };
      if (!frame) frame = requestAnimationFrame(sync);
    }, { passive: true });
    container.addEventListener('pointerleave', release);
    container.addEventListener('scroll', release, { passive: true });
  }
  return { insert, refresh, locate, bindSourceHover };
}
