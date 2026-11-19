import { windowStorage } from './window-storage.js';
import { t as tr } from './i18n.js';

/** Dividers use layout pixels so saved sizes also work at a different zoom. */
export function initAgentResize(sidebar, footer) {
  const host = sidebar.parentElement;
  const active = () => document.body.classList.contains('agent-full') && !document.body.classList.contains('agent-nav-collapsed') && innerWidth > 700;
  const scale = () => sidebar.getBoundingClientRect().width / sidebar.offsetWidth || 1;
  for (const entry of [
    { axis: 'x', node: sidebar, key: 'reader.agent.sidebarWidth', css: '--agent-sidebar-width', label: tr('调整侧栏宽度') },
    { axis: 'y', node: footer, key: 'reader.agent.readingHeight', css: '--agent-reading-height', label: tr('调整阅读卡高度') },
  ]) {
    let preferred = null, drag = null;
    try { const n = Number(windowStorage.getItem(entry.key)); if (n > 0) preferred = n; } catch {}
    const grip = document.createElement('div');
    grip.className = `agent-resize agent-resize-${entry.axis}`; grip.tabIndex = 0;
    grip.setAttribute('role', 'separator'); grip.setAttribute('aria-label', entry.label);
    grip.setAttribute('aria-orientation', entry.axis === 'x' ? 'vertical' : 'horizontal');
    entry.node.id ||= 'agentReadingFoot'; grip.setAttribute('aria-controls', entry.node.id);
    grip.title = tr('拖动调整，双击恢复默认'); entry.node.append(grip);
    const limits = () => {
      if (entry.axis === 'x') return [180, Math.max(180, Math.min(460, host.clientWidth / scale() - 340))];
      const style = getComputedStyle(sidebar);
      const fixed = [...sidebar.children].filter(n => n !== footer && !n.classList.contains('agent-nav-recents') && !n.classList.contains('agent-resize'));
      const used = fixed.reduce((sum, n) => sum + n.offsetHeight, 0)
        + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
        + (parseFloat(style.rowGap) || 0) * fixed.length + 56;
      const max = Math.max(80, sidebar.clientHeight - used);
      const min = Math.max(108, (footer.querySelector('.agent-resume-copy')?.scrollHeight || 0) + 40);
      return [Math.min(min, max), max];
    };
    const fit = () => {
      if (!active() || !entry.node.getClientRects().length) return;
      const [min, max] = limits();
      if (entry.axis === 'y') sidebar.style.setProperty('--agent-reading-max', `${max}px`);
      const value = preferred === null ? null : Math.max(min, Math.min(max, preferred));
      if (value === null) sidebar.style.removeProperty(entry.css);
      else sidebar.style.setProperty(entry.css, `${value}px`);
      grip.setAttribute('aria-valuemin', String(Math.round(min)));
      grip.setAttribute('aria-valuemax', String(Math.round(max)));
      grip.setAttribute('aria-valuenow', String(Math.round(value ?? (entry.axis === 'x' ? sidebar.offsetWidth : footer.offsetHeight))));
    };
    const save = () => { try { if (preferred === null) windowStorage.removeItem(entry.key); else windowStorage.setItem(entry.key, String(preferred)); } catch {} };
    const finish = cancel => {
      if (!drag) return;
      const old = drag; drag = null;
      if (cancel) preferred = old.preferred; else save();
      document.documentElement.classList.remove(`agent-resizing-${entry.axis}`);
      if (grip.hasPointerCapture(old.id)) grip.releasePointerCapture(old.id);
      fit();
    };
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag || !active()) return;
      event.preventDefault(); grip.focus({ preventScroll: true });
      drag = { id: event.pointerId, start: entry.axis === 'x' ? event.clientX : event.clientY,
        size: entry.axis === 'x' ? sidebar.offsetWidth : footer.offsetHeight, scale: scale(), preferred };
      grip.setPointerCapture(event.pointerId); document.documentElement.classList.add(`agent-resizing-${entry.axis}`);
    });
    grip.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const delta = entry.axis === 'x' ? event.clientX - drag.start : drag.start - event.clientY;
      const [min, max] = limits(); preferred = Math.max(min, Math.min(max, drag.size + delta / drag.scale)); fit();
    });
    grip.addEventListener('pointerup', () => finish(false));
    grip.addEventListener('pointercancel', () => finish(true));
    grip.addEventListener('lostpointercapture', () => finish(true));
    window.addEventListener('blur', () => finish(true));
    grip.addEventListener('dblclick', () => { finish(true); preferred = null; fit(); save(); });
    grip.addEventListener('keydown', event => {
      if (event.key === 'Escape') { finish(true); return; }
      const plus = entry.axis === 'x' ? 'ArrowRight' : 'ArrowUp', minus = entry.axis === 'x' ? 'ArrowLeft' : 'ArrowDown';
      if (![plus, minus, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const [min, max] = limits(), size = entry.axis === 'x' ? sidebar.offsetWidth : footer.offsetHeight;
      preferred = event.key === 'Home' ? min : event.key === 'End' ? max
        : Math.max(min, Math.min(max, size + (event.key === plus ? 1 : -1) * (event.shiftKey ? 30 : 10)));
      fit(); save();
    });
    const observer = new ResizeObserver(fit); observer.observe(host); observer.observe(sidebar);
    new MutationObserver(fit).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(fit).observe(footer, { childList: true, subtree: true, characterData: true });
    fit();
  }
}
