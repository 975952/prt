import { t } from './i18n.js';

const KEY = 'prt.readingToolbar.v1';
const defaults = ['left', 'pager', 'zoom', 'search', 'explore', 'more', 'right'];
const names = { left: '左栏', pager: '翻页', zoom: '缩放', search: '查找', explore: '读懂论文',
  more: '更多阅读工具', right: '右栏', two: '双页显示', immersive: '沉浸翻书' };
const fixed = new Set(['left', 'pager', 'zoom', 'more', 'right']);

export function placeToolMenu(menu, trigger) {
  const box = trigger.getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const left = Math.max(6, Math.min(innerWidth - width - 6, box.right - width));
  const top = Math.max(6, Math.min(innerHeight - height - 6, box.bottom + 5));
  Object.assign(menu.style, { left: left + 'px', top: top + 'px', right: 'auto' });
}

export function initReaderToolbar() {
  const bar = document.getElementById('viewerFoot'), extra = document.getElementById('readerExtraTools');
  if (!bar || !extra) return;
  const nodes = new Map([...bar.children, ...extra.children].map(el => [el.dataset.tool, el]));
  const editor = document.getElementById('readerToolEditor'), choices = document.getElementById('readerToolChoices');
  const more = document.getElementById('readerMore'), moreMenu = document.getElementById('readerMoreMenu');
  const zoom = document.getElementById('readerZoom'), zoomMenu = document.getElementById('readerZoomMenu');
  const edit = document.getElementById('editReaderTools'), done = document.getElementById('readerToolsDone');
  const searchLabel = document.createElement('span');
  searchLabel.className = 'menu-only'; searchLabel.textContent = t(names.search);
  nodes.get('search').querySelector('button').append(searchLabel);
  let order = [...defaults];
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(saved) && [...fixed].every(id => saved.includes(id)))
      order = [...new Set(saved.filter(id => nodes.has(id)))];
  } catch { /* A fresh profile uses the default arrangement. */ }
  function render(save = false) {
    bar.append(...order.map(id => nodes.get(id)));
    extra.append(...[...nodes].filter(([id]) => !order.includes(id)).map(([, el]) => el));
    if (save) try { localStorage.setItem(KEY, JSON.stringify(order)); } catch { /* memory-only */ }
    choices.replaceChildren();
    for (const id of [...order, ...[...nodes.keys()].filter(id => !order.includes(id))]) {
      const row = document.createElement('div'), name = document.createElement('span');
      const index = order.indexOf(id);
      row.className = 'reader-tool-choice'; row.dataset.choice = id;
      name.textContent = t(names[id]); row.append(name); choices.append(row);
      for (const [action, symbol, label, disabled] of [
        ['left', '‹', '工具左移', index <= 0], ['right', '›', '工具右移', index < 0 || index === order.length - 1],
        ['pin', index < 0 ? '+' : '−', index < 0 ? '固定到工具栏' : '移到更多工具', fixed.has(id)],
      ]) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = symbol; button.className = 'tbtn';
        button.dataset.action = action; button.disabled = disabled;
        button.title = t(label); button.setAttribute('aria-label', t(label) + ' · ' + name.textContent);
        row.append(button);
      }
    }
  }
  function openEditor() {
    moreMenu.hidePopover();
    if (!editor.matches(':popover-open')) editor.showPopover();
    placeToolMenu(editor, more);
    done.focus({ preventScroll: true });
  }
  function move(id, before) {
    if (id === before) return;
    order = order.filter(tool => tool !== id);
    const index = order.indexOf(before);
    order.splice(index < 0 ? order.length : index, 0, id);
    render(true);
  }
  choices.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const id = button.closest('[data-choice]').dataset.choice, index = order.indexOf(id);
    if (button.dataset.action === 'pin') {
      if (index < 0) move(id, 'more');
      else { order.splice(index, 1); render(true); }
    } else move(id, order[index + (button.dataset.action === 'left' ? -1 : 2)]);
    const row = choices.querySelector('[data-choice="' + id + '"]');
    (row.querySelector('[data-action="' + button.dataset.action + '"]:enabled') || row.querySelector('button:enabled') || done).focus();
    placeToolMenu(editor, more);
  });
  document.getElementById('readerToolsReset').onclick = () => { order = [...defaults]; render(true); placeToolMenu(editor, more); };
  edit.onclick = openEditor;
  done.onclick = () => { editor.hidePopover(); more.focus(); };
  const pairs = [[moreMenu, more], [zoomMenu, zoom], [editor, more]];
  function positionMenus() {
    for (const [menu, trigger] of pairs) if (menu.matches(':popover-open')) {
      if (trigger.getClientRects().length) placeToolMenu(menu, trigger);
      else menu.hidePopover();
    }
  }
  for (const [menu] of pairs) menu.addEventListener('toggle', positionMenus);
  extra.addEventListener('click', e => { if (e.target.closest('button')) moreMenu.hidePopover(); });
  document.getElementById('footFitWidth').addEventListener('click', () => zoomMenu.hidePopover());
  new ResizeObserver(positionMenus).observe(bar);
  window.addEventListener('resize', positionMenus);

  // A normal click keeps its reading action. A long press starts a drag in the
  // same pointer sequence. The editor's buttons provide an equivalent keyboard path.
  let press = null, dragging = false, swallowClick = false, drop = null;
  function reset() {
    if (press) clearTimeout(press.timer);
    press = null; dragging = false; drop = null;
    bar.classList.remove('tool-dragging'); editor.classList.remove('tool-drop-remove');
    bar.querySelectorAll('.tool-insert, .tool-last').forEach(el => el.classList.remove('tool-insert', 'tool-last'));
  }
  function locate(x, y) {
    const bounds = bar.getBoundingClientRect(), panel = editor.getBoundingClientRect();
    const inside = x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
    const inPanel = x >= panel.left && x <= panel.right && y >= panel.top && y <= panel.bottom;
    const targets = [...bar.children].filter(el => el.dataset.tool !== press.id);
    const before = inside && targets.find(el => { const rect = el.getBoundingClientRect(); return x < rect.left + rect.width / 2; });
    drop = inside ? { before: before?.dataset.tool } : inPanel && !fixed.has(press.id) ? { remove: true } : null;
    for (const el of bar.children) {
      el.classList.toggle('tool-insert', el === before);
      el.classList.toggle('tool-last', inside && !before && el === targets.at(-1));
    }
    editor.classList.toggle('tool-drop-remove', !!drop?.remove);
  }
  function start() {
    if (!press) return;
    dragging = true; swallowClick = true;
    openEditor(); bar.classList.add('tool-dragging');
  }
  function down(event) {
    if (event.button !== 0 || !event.isPrimary || event.target.closest('input, #readerToolChoices button')) return;
    const tool = event.target.closest('[data-tool], [data-choice]');
    if (!tool) return;
    reset();
    swallowClick = false;
    press = { id: tool.dataset.tool || tool.dataset.choice, pointer: event.pointerId, x: event.clientX, y: event.clientY };
    press.timer = setTimeout(start, 400);
  }
  bar.addEventListener('pointerdown', down); choices.addEventListener('pointerdown', down);
  // Keep quick swipes native on overflowing toolbars. Once a long press starts
  // editing, stop Chromium from taking the horizontal gesture for scrolling.
  bar.addEventListener('touchmove', event => {
    if (dragging && event.cancelable) event.preventDefault();
  }, { passive: false });
  document.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.pointer) return;
    if (!dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 7) {
      if (editor.matches(':popover-open')) { clearTimeout(press.timer); start(); } else { reset(); return; }
    }
    if (dragging) { e.preventDefault(); locate(e.clientX, e.clientY); }
  });
  document.addEventListener('pointerup', e => {
    if (!press || e.pointerId !== press.pointer) return;
    if (dragging) {
      if (drop?.remove) { order = order.filter(id => id !== press.id); render(true); }
      else if (drop) move(press.id, drop.before);
      placeToolMenu(editor, more);
    }
    reset();
    setTimeout(() => { swallowClick = false; }, 0);
  });
  document.addEventListener('click', e => {
    if (swallowClick) { e.preventDefault(); e.stopImmediatePropagation(); swallowClick = false; }
  }, true);
  for (const event of ['pointercancel', 'blur']) window.addEventListener(event, () => { reset(); swallowClick = false; });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (dragging || pairs.some(([menu]) => menu.matches(':popover-open')))) {
      const trigger = zoomMenu.matches(':popover-open') ? zoom : more;
      reset(); swallowClick = false;
      for (const [menu] of pairs) menu.hidePopover();
      e.preventDefault(); e.stopImmediatePropagation(); trigger.focus();
    }
  }, true);
  render();
}
