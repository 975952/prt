const initialized = new WeakSet();
const KEY = 'reader.library.sidebarWidth';

/** Sizes are stored in layout pixels, independent of Library zoom. */
export function initLibrarySidebar(home, { storage = window.localStorage, label = 'Resize Library sidebar', resetLabel = 'Drag to resize; double-click to reset' } = {}) {
  if (!home || initialized.has(home)) return;
  const sidebar = home.querySelector('.home-sidebar');
  if (!sidebar) return;
  initialized.add(home);
  let preferred = null, drag = null;
  try { const value = Number(storage.getItem(KEY)); if (Number.isFinite(value) && value >= 160) preferred = Math.min(420, value); } catch {}
  const grip = document.createElement('div');
  grip.className = 'home-sidebar-resize'; grip.tabIndex = 0;
  grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', label); grip.title = resetLabel;
  sidebar.id ||= 'homeSidebar'; grip.setAttribute('aria-controls', sidebar.id);
  sidebar.append(grip);
  const maximum = () => Math.max(160, Math.min(420, home.clientWidth - 360));
  const fit = () => {
    if (!home.clientWidth) return;
    if (preferred === null) home.style.removeProperty('--library-sidebar-width');
    else home.style.setProperty('--library-sidebar-width', `${Math.max(160, Math.min(maximum(), preferred))}px`);
    grip.setAttribute('aria-valuemin', '160'); grip.setAttribute('aria-valuemax', String(maximum()));
    grip.setAttribute('aria-valuenow', String(Math.round(sidebar.getBoundingClientRect().width / (home.getBoundingClientRect().width / home.offsetWidth))));
  };
  const save = () => { try { if (preferred === null) storage.removeItem(KEY); else storage.setItem(KEY, String(preferred)); } catch {} };
  const finish = (cancel = false) => {
    if (!drag) return;
    const previous = drag; drag = null;
    if (cancel) preferred = previous.preferred; else save();
    document.documentElement.classList.remove('library-sidebar-dragging');
    if (grip.hasPointerCapture(previous.id)) grip.releasePointerCapture(previous.id);
    fit();
  };
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || getComputedStyle(home).display !== 'grid') return;
    event.preventDefault(); grip.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width: sidebar.offsetWidth, preferred,
      scale: home.getBoundingClientRect().width / home.offsetWidth };
    grip.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('library-sidebar-dragging');
  });
  grip.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    preferred = Math.max(160, Math.min(maximum(), drag.width + (event.clientX - drag.x) / drag.scale)); fit();
  });
  grip.addEventListener('pointerup', () => finish());
  grip.addEventListener('pointercancel', () => finish(true));
  grip.addEventListener('lostpointercapture', () => finish(true));
  window.addEventListener('blur', () => finish(true));
  grip.addEventListener('dblclick', () => { finish(true); preferred = null; fit(); save(); });
  grip.addEventListener('keydown', event => {
    if (event.key === 'Escape') { finish(true); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    preferred = event.key === 'Home' ? 160 : event.key === 'End' ? maximum()
      : Math.max(160, Math.min(maximum(), sidebar.offsetWidth + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 30 : 10)));
    fit(); save();
  });
  new ResizeObserver(fit).observe(home);
  fit();
}
