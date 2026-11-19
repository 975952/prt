import { el } from './util.js';
import { iconEl } from './icons.js';
import { t as tr } from './i18n.js';

/** Separate from ordinary fullscreen. Keeps the live conversation DOM intact. */
export function createImmersiveReading({ getViewer, enterFullscreen, leaveFullscreen, isFullscreen,
  prepareChat, restoreLayout, openTranslations, beforeEnter, onExit, onError } = {}) {
  let active = false, busy = false, ownedFullscreen = false, hideTimer = 0, hideDeadline = 0, turnTimer = 0, down = null;
  let wheelAt = 0, wheelDistance = 0, wheelTurned = false;
  const body = document.body, viewerElement = document.getElementById('viewer');
  const button = (id, label, icon, action) => el('button', { id, type: 'button', class: 'immersive-control',
    title: label, 'aria-label': label, onclick: event => { action(event); if (event.detail) event.currentTarget.blur(); } }, iconEl(icon), el('span', { text: label }));
  const exit = button('immersiveExit', tr('退出翻书'), 'chevron-left', () => setActive(false));
  const translate = button('immersiveTranslate', tr('翻译'), 'translate', () => { openTranslations?.(); raiseCard('translate'); reveal(); });
  const chat = button('immersiveChat', tr('问答'), 'chat', () => showChat(!body.classList.contains('immersive-chat-open') || body.dataset.immersiveCard !== 'chat'));
  const top = el('nav', { id: 'immersiveTopbar', class: 'immersive-chrome', 'aria-label': tr('沉浸翻书工具') },
    exit, el('span', { class: 'immersive-title', text: tr('沉浸翻书') }), translate, chat);
  const prev = button('immersivePrev', tr('上一页'), 'chevron-left', () => turn(-1));
  const next = button('immersiveNext', tr('下一页'), 'chevron-right', () => turn(1));
  const page = el('input', { id: 'immersivePage', type: 'number', min: '1', 'aria-label': tr('页码') });
  const total = el('span', { id: 'immersiveTotal' });
  const bottom = el('nav', { id: 'immersiveFooter', class: 'immersive-chrome', 'aria-label': tr('翻页') }, prev, page, total, next);
  body.append(top, bottom);
  viewerElement.tabIndex = -1;
  const side = document.getElementById('rightSide');
  const columns = document.getElementById('rightCols');
  const translation = document.getElementById('translationCard');
  const columnsHome = document.createComment('Reading sidebar home');
  columns.before(columnsHome);
  const cardHead = el('div', { class: 'reading-qa-card-head', id: 'immersiveChatHead' }, iconEl('chat'),
    el('span', { class: 'reading-qa-card-title', text: tr('问答') }),
    button('immersiveChatClose', tr('收起问答'), 'close', () => showChat(false)));
  side.prepend(cardHead);

  function raiseCard(card) {
    if (active) body.dataset.immersiveCard = card;
  }
  for (const [card, name] of [[side, 'chat'], [translation, 'translate']]) {
    card.addEventListener('pointerdown', () => raiseCard(name), true);
    card.addEventListener('focusin', () => raiseCard(name));
  }
  // Selection and screenshot translations also open the same card outside the
  // toolbar callback. Raising it only on open keeps streaming from stealing it.
  new MutationObserver(records => {
    if (!translation.classList.contains('hidden') && records.some(record => /(?:^|\s)hidden(?:\s|$)/.test(record.oldValue || ''))) raiseCard('translate');
  }).observe(translation, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });

  function scheduleHide(delay = 160) {
    const deadline = performance.now() + delay;
    if (hideTimer && hideDeadline <= deadline) return;
    clearTimeout(hideTimer);
    hideDeadline = deadline;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      if (top.matches(':hover') || bottom.matches(':hover') || top.contains(document.activeElement) || bottom.contains(document.activeElement)) return;
      body.classList.remove('immersive-chrome-visible');
    }, delay);
  }
  function reveal(delay = 900) {
    if (!active) return;
    body.classList.add('immersive-chrome-visible');
    scheduleHide(delay);
  }
  function sync() {
    const viewer = getViewer();
    page.value = String(viewer?.current || 1); page.max = String(viewer?.numPages || 1);
    total.textContent = `/ ${viewer?.numPages || 0}`;
    prev.disabled = (viewer?.current || 1) <= 2;
    next.disabled = (viewer?.current || 1) + ((viewer?.current || 1) % 2 ? 1 : 0) >= (viewer?.numPages || 0);
  }
  async function turn(direction) {
    if (!active || busy) return;
    try { await getViewer()?.stepPage(direction); }
    catch (error) { onError?.(error); }
    finally { sync(); }
  }
  function showChat(show = true) {
    if (!active) return;
    body.classList.toggle('immersive-chat-open', show);
    chat.setAttribute('aria-pressed', String(show));
    if (show) { prepareChat?.(); side.classList.add('reading-qa-card'); fitChatCard(); raiseCard('chat'); }
    reveal();
  }
  function dismissMostRecentCard() {
    const chatOpen = body.classList.contains('immersive-chat-open');
    const translateOpen = !translation.classList.contains('hidden');
    if (!chatOpen && !translateOpen) return false;
    const recent = body.dataset.immersiveCard;
    if (recent === 'chat' && chatOpen) showChat(false);
    else if (recent === 'translate' && translateOpen) translation.querySelector('#translationCardClose')?.click();
    else if (chatOpen) showChat(false);
    else translation.querySelector('#translationCardClose')?.click();
    return true;
  }
  function fitChatCard() {
    if (!active || !body.classList.contains('immersive-chat-open')) return;
    const box = side.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - box.width - 8, box.left));
    const top = Math.max(8, Math.min(innerHeight - box.height - 8, box.top));
    if (left !== box.left) { side.style.right = 'auto'; side.style.left = `${left}px`; }
    if (top !== box.top) side.style.top = `${top}px`;
  }
  window.addEventListener('resize', fitChatCard);
  async function setActive(on) {
    if (busy || active === !!on || (on && !getViewer()?.pdf)) return;
    busy = true;
    try {
      if (on) {
        beforeEnter?.();
        ownedFullscreen = !isFullscreen?.();
        // Request fullscreen in the original click's activation, before any await.
        const fullscreen = ownedFullscreen ? enterFullscreen?.() : null;
        active = true; body.classList.add('immersive-reading');
        wheelAt = 0; wheelDistance = 0; wheelTurned = false;
        raiseCard(translation.classList.contains('hidden') ? 'chat' : 'translate');
        // Escape the fixed reader's stacking context without replacing live chat DOM.
        body.append(columns);
        document.getElementById('immersiveBtn')?.setAttribute('aria-pressed', 'true');
        await fullscreen;
        await getViewer().setImmersive(true);
        sync(); reveal(); viewerElement.focus({ preventScroll: true });
      } else {
        active = false; clearTimeout(hideTimer); hideTimer = 0; clearTimeout(turnTimer);
        body.classList.remove('immersive-reading', 'immersive-chat-open', 'immersive-chrome-visible');
        delete body.dataset.immersiveCard;
        columnsHome.after(columns);
        document.getElementById('immersiveBtn')?.setAttribute('aria-pressed', 'false');
        side.classList.remove('reading-qa-card');
        for (const name of ['left', 'right', 'top', 'width', 'height']) side.style.removeProperty(name);
        restoreLayout?.();
        if (ownedFullscreen) await leaveFullscreen?.();
        await getViewer().setImmersive(false);
        onExit?.();
      }
    } catch (error) {
      active = false; clearTimeout(hideTimer); hideTimer = 0; clearTimeout(turnTimer);
      body.classList.remove('immersive-reading', 'immersive-chat-open', 'immersive-chrome-visible');
      delete body.dataset.immersiveCard;
      columnsHome.after(columns);
      document.getElementById('immersiveBtn')?.setAttribute('aria-pressed', 'false');
      side.classList.remove('reading-qa-card');
      for (const name of ['left', 'right', 'top', 'width', 'height']) side.style.removeProperty(name);
      restoreLayout?.();
      if (ownedFullscreen) await leaveFullscreen?.();
      try { await getViewer()?.setImmersive(false); } catch { /* Keep the normal controls available for retry. */ }
      onError?.(error);
    } finally { busy = false; }
  }
  page.addEventListener('change', async () => {
    try { await getViewer()?.goToPage(Number(page.value)); } catch (error) { onError?.(error); }
    finally { sync(); }
  });
  page.addEventListener('keydown', event => { if (event.key === 'Enter') { page.blur(); } });
  document.getElementById('immersiveBtn')?.addEventListener('click', () => setActive(!active));
  document.addEventListener('pointermove', event => {
    if (!active) return;
    const overCard = event.target.closest('#translationCard,#rightSide');
    if (!overCard && (event.clientY < 56 || event.clientY > innerHeight - 56 || top.contains(event.target) || bottom.contains(event.target))) {
      body.classList.add('immersive-chrome-visible'); clearTimeout(hideTimer); hideTimer = 0;
    } else if (body.classList.contains('immersive-chrome-visible')) scheduleHide();
  });
  for (const bar of [top, bottom]) {
    bar.addEventListener('pointerleave', () => scheduleHide());
    bar.addEventListener('focusin', () => reveal());
    bar.addEventListener('focusout', () => scheduleHide());
  }
  viewerElement.addEventListener('pointerdown', event => {
    down = active && event.button === 0 ? { x: event.clientX, y: event.clientY, time: performance.now() } : null;
  });
  viewerElement.addEventListener('click', event => {
    if (!active || !down || event.button || event.detail > 1 || event.target.closest('a,button,input,[role="button"],.annotationLayer')) return;
    const start = down; down = null;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || performance.now() - start.time > 600) return;
    if (getSelection()?.toString().trim() || getViewer()?.getSelectionInfo()?.cleanText) return;
    if (dismissMostRecentCard()) return;
    clearTimeout(turnTimer);
    const bounds = viewerElement.getBoundingClientRect();
    turnTimer = setTimeout(() => {
      if (!getSelection()?.toString().trim()) turn(event.clientX < bounds.left + bounds.width / 2 ? -1 : 1);
    }, 220);
  });
  viewerElement.addEventListener('dblclick', () => clearTimeout(turnTimer));
  viewerElement.addEventListener('wheel', event => {
    if (!active || event.ctrlKey || event.metaKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      || event.target.closest('input,textarea,select,[contenteditable="true"],#translationCard,#rightSide')) return;
    event.preventDefault();
    const now = performance.now();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewerElement.clientHeight : 1);
    // A touchpad gesture has many small momentum events. Turn once for that
    // burst, while a fresh wheel action or direction reversal starts anew.
    if (now - wheelAt > 140 || Math.sign(delta) !== Math.sign(wheelDistance)) { wheelDistance = 0; wheelTurned = false; }
    wheelAt = now;
    wheelDistance += delta;
    if (!wheelTurned && Math.abs(wheelDistance) >= 36) {
      wheelTurned = true;
      clearTimeout(turnTimer);
      turn(Math.sign(wheelDistance));
    }
  }, { passive: false });
  document.addEventListener('keydown', event => {
    if (!active || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey
      || event.target.closest('input,textarea,select,[contenteditable="true"],#translationCard,#rightSide')) return;
    if (['ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp', ' '].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation(); turn(['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1);
    }
  }, true);
  // Move the QA card by its own header without moving/resizing the reading spread.
  cardHead.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const box = side.getBoundingClientRect(), x = event.clientX, y = event.clientY;
    cardHead.setPointerCapture(event.pointerId);
    const move = e => {
      side.style.right = 'auto';
      side.style.left = `${Math.max(8, Math.min(innerWidth - box.width - 8, box.left + e.clientX - x))}px`;
      side.style.top = `${Math.max(8, Math.min(innerHeight - box.height - 8, box.top + e.clientY - y))}px`;
    };
    const up = () => { cardHead.removeEventListener('pointermove', move); cardHead.removeEventListener('pointerup', up); cardHead.removeEventListener('pointercancel', up); };
    cardHead.addEventListener('pointermove', move); cardHead.addEventListener('pointerup', up); cardHead.addEventListener('pointercancel', up);
  });
  return { setActive, showChat, sync, reveal, get active() { return active; } };
}
