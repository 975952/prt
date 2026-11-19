import { t as tr } from './i18n.js';
import { el } from './util.js';
import { iconEl } from './icons.js';
import { DEFAULT_AGENT_PROFILE, normalizeAgentProfile, agentDisplayName } from './agent-profile.js';
import { createAgentSettings } from './agent-settings.js';
import { createAgentMotion } from './agent-motion.js';
import { windowStorage } from './window-storage.js';

/** UI only: the caller owns conversation scope, persistence, and document navigation. */
export function createAgentWorkspace({ onOpen, onBack, onExpand, onOpenPaper, onOpenPapers,
  onContinue, onRestore, onNew, onStartSearch, onResume, onHistory, onLanding, onSessionSelect, onSettings,
  getPapers = () => [], onNameChange, onProfileChange } = {}) {
  const byId = id => document.getElementById(id);
  const ui = Object.fromEntries(['agentBtn', 'homeAgent', 'agentIdentity', 'agentNameDisplay', 'agentExpand', 'agentPapersToggle', 'agentLandingBack',
    'agentLanding', 'agentLaunchActions', 'agentStartSearch', 'agentResume', 'agentHistory', 'agentRecentTitle', 'chatInput',
    'agentPaperPicker', 'agentPaperSearch', 'agentPaperList', 'agentPapersClose', 'agentHandoff', 'agentHandoffLayer',
    'agentHandoffContext', 'agentContinue', 'agentRestore', 'agentNew', 'agentStatus', 'rightSide', 'aiArea', 'sessHistory',
    'homeBtn', 'agentNavNew', 'agentNavRecent']
    .map(id => [id, byId(id)]));
  const paperActionHome = ui.agentIdentity.querySelector('.agent-identity-actions');
  const primaryNav = ui.agentNavNew.parentElement;
  const sidebarKey = 'reader.agent.sidebarCollapsed';
  let sidebarCollapsed = false;
  try { sidebarCollapsed = windowStorage.getItem(sidebarKey) === '1'; } catch { /* Private storage is optional. */ }
  const sidebarToggle = el('button', { type: 'button', id: 'agentSidebarToggle', class: 'agent-sidebar-toggle',
    'aria-controls': 'agentNav', onclick: () => {
      if (transitioning) return;
      sidebarCollapsed = !sidebarCollapsed;
      try { windowStorage.setItem(sidebarKey, sidebarCollapsed ? '1' : '0'); } catch { /* Keep the in-memory preference. */ }
      updateSidebar();
    } });
  primaryNav.before(sidebarToggle);
  const defaultProfile = DEFAULT_AGENT_PROFILE;
  const limitText = (value, limit) => [...String(value ?? '').trim()].slice(0, limit).join('');
  let profile = { ...defaultProfile };
  let view = 'closed', name = profile.name, transitioning = false, busy = false, animation = null;
  let paperRevision = 0, handoffFrame = 0, handoffVersion = 0, handoffAnimation = null, handoffClosing = false;
  let landing = false, hasRecent = false, composerAnimation = null, composerFrame = 0, composerVersion = 0;
  const motion = createAgentMotion();
  const settings = createAgentSettings({ onSave: async next => {
    if (onProfileChange) await onProfileChange(next);
    else await onNameChange?.(next.name);
    profile = normalizeAgentProfile(next); setName(profile.name);
  } });

  function updateSidebar() {
    const label = tr(sidebarCollapsed ? '展开侧栏' : '收起侧栏');
    document.body.classList.toggle('agent-nav-collapsed', sidebarCollapsed);
    sidebarToggle.title = label;
    sidebarToggle.setAttribute('aria-label', label);
    sidebarToggle.setAttribute('aria-expanded', String(!sidebarCollapsed));
    sidebarToggle.replaceChildren(iconEl(sidebarCollapsed ? 'panel-expand-left' : 'panel-collapse-left'),
      el('span', { text: label }));
  }
  updateSidebar();
  for (const button of [ui.agentNavNew, ui.agentHistory]) {
    const label = button.textContent.trim();
    button.title = label; button.setAttribute('aria-label', label);
  }

  for (const host of document.querySelectorAll('[data-agent-icon]')) {
    if (!host.firstElementChild) host.append(iconEl(host.dataset.agentIcon));
  }

  function status(text = '') {
    ui.agentStatus.textContent = text;
    ui.agentStatus.hidden = !text;
  }
  function disabled() {
    for (const id of ['agentExpand', 'agentContinue', 'agentRestore', 'agentNew', 'agentLandingBack',
      'agentStartSearch', 'agentResume', 'agentHistory', 'agentNavNew', 'agentPapersToggle']) {
      ui[id].disabled = busy || transitioning;
    }
    ui.agentResume.disabled ||= !hasRecent;
    for (const button of ui.agentPaperList.querySelectorAll('button')) button.disabled = busy || transitioning;
    for (const button of ui.agentNavRecent.querySelectorAll('button')) button.disabled = busy || transitioning;
    ui.rightSide.setAttribute('aria-busy', String(busy || transitioning));
  }
  async function act(action, ...args) {
    if (busy || transitioning || typeof action !== 'function') return;
    busy = true; status(); disabled();
    try { return await action(...args); }
    catch (error) { status(String(error?.message || tr('操作失败，请重试。'))); }
    finally { busy = false; disabled(); }
  }
  // Kept for callers from earlier versions. Identity editing lives in Settings.
  function closeName() {}
  function showNameSetup() {}
  function closePapers({ focus = false } = {}) {
    ui.agentPaperPicker.hidden = true;
    ui.agentPapersToggle.setAttribute('aria-expanded', 'false');
    if (focus) ui.agentPapersToggle.focus({ preventScroll: true });
  }
  function setName(value) {
    profile.name = limitText(value, 32) || defaultProfile.name;
    name = agentDisplayName(profile);
    for (const node of document.querySelectorAll('[data-agent-name]')) node.textContent = name;
    ui.agentBtn.title = tr('打开{0}', name);
    ui.agentBtn.setAttribute('aria-label', tr('打开{0}', name));
    ui.homeAgent.setAttribute('aria-label', tr('打开{0}', name));
  }
  function setProfile(value = {}) {
    profile = normalizeAgentProfile(value);
    setName(profile.name); settings.setProfile(profile);
  }
  function setLanding(on, options = {}) {
    const revision = ++composerVersion;
    const leaving = landing && !on && view === 'full' && !transitioning;
    const entering = !landing && !!on && view === 'full';
    const composer = byId('composer');
    const inputCard = composer.querySelector('.composer-row');
    const before = leaving && inputCard?.getClientRects().length ? inputCard.getBoundingClientRect() : null;
    landing = !!on && view === 'full';
    if ('hasRecent' in options) hasRecent = !!options.hasRecent;
    if ('recentTitle' in options) {
      const title = String(options.recentTitle || '').trim().slice(0, 160);
      ui.agentRecentTitle.textContent = title || tr('还没有历史会话');
      ui.agentRecentTitle.title = title;
      ui.agentRecentTitle.hidden = false;
    }
    document.body.classList.toggle('agent-landing', landing);
    ui.agentNavNew.setAttribute('aria-current', landing ? 'page' : 'false');
    ui.agentLanding.hidden = !landing; ui.agentLaunchActions.hidden = !landing;
    byId('agentReadingEntry').classList.remove('agent-launch', 'workspace-action');
    if (entering) { closePapers(); hideHandoff(); }
    disabled(); positionHandoff();
    if (composerFrame) { cancelAnimationFrame(composerFrame); composerFrame = 0; }
    composerAnimation?.cancel(); composerAnimation = null;
    if (before?.height > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches
      && typeof composer.animate === 'function') {
      // Send clears and resizes the textarea in this same task. Measure its final
      // footer position before the next paint, rather than animating stale height.
      composerFrame = requestAnimationFrame(() => {
        composerFrame = 0;
        if (revision !== composerVersion || landing || view !== 'full') return;
        const after = composer.getBoundingClientRect();
        const cardAfter = inputCard.getBoundingClientRect();
        if (after.height <= 0 || cardAfter.width <= 0 || cardAfter.height <= 0) return;
        const scale = after.width / composer.offsetWidth || 1;
        const sx = before.width / cardAfter.width, sy = before.height / cardAfter.height;
        // Match the visible input card, including its size and the different
        // landing/footer padding. The outer form remains the same DOM node.
        const dx = before.left - after.left - (cardAfter.left - after.left) * sx;
        const dy = before.top - after.top - (cardAfter.top - after.top) * sy;
        composerAnimation = composer.animate([
          { transformOrigin: 'top left', transform: `translate(${dx / scale}px, ${dy / scale}px) scale(${sx}, ${sy})` },
          { transformOrigin: 'top left', transform: 'translate(0, 0) scale(1, 1)' },
        ], { duration: 260, easing: 'cubic-bezier(.22, .8, .25, 1)' });
        ui.aiArea.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
      });
    }
  }
  function setView(next) {
    if (!['full', 'docked', 'closed'].includes(next)) return;
    view = next;
    document.body.classList.toggle('agent-full', next === 'full');
    document.body.classList.toggle('agent-docked', next === 'docked');
    // One action follows the workspace: a named navigation entry in full view,
    // then the same control returns to the compact reader header when docked.
    if (next === 'full') primaryNav.insertBefore(ui.agentPapersToggle, ui.agentHistory);
    else paperActionHome.insertBefore(ui.agentPapersToggle, ui.agentExpand);
    ui.agentPapersToggle.classList.toggle('agent-nav-button', next === 'full');
    ui.agentPapersToggle.classList.toggle('agent-action', next !== 'full');
    ui.agentPapersToggle.title = tr('打开论文');
    ui.agentPapersToggle.setAttribute('aria-label', tr('打开论文'));
    ui.agentIdentity.hidden = next === 'closed';
    ui.agentBtn.setAttribute('aria-expanded', String(next === 'full'));
    ui.agentBtn.setAttribute('aria-current', next === 'full' ? 'page' : 'false');
    ui.homeAgent.setAttribute('aria-current', next === 'full' ? 'page' : 'false');
    if (next !== 'full') setLanding(false);
    if (next !== 'full') closePapers();
    closeName();
    if (next === 'closed') hideHandoff();
    status();
    positionHandoff();
  }
  function setTransitioning(on) {
    transitioning = !!on;
    document.body.classList.toggle('agent-transitioning', transitioning);
    disabled();
  }
  function setRecentConversations(rows = [], selectedSid = '') {
    const list = rows.filter(row => !row.archived && row.count > 0)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 7);
    ui.agentNavRecent.replaceChildren(...(list.length ? list.map(row => el('button', {
      type: 'button', class: 'agent-nav-session', text: row.title || tr('新会话'),
      title: row.title || tr('新会话'), dataset: { agentSession: row.sid },
      'aria-current': !landing && row.sid === selectedSid ? 'page' : 'false',
      onclick: () => act(onSessionSelect, row),
    })) : [el('p', { class: 'agent-nav-empty', text: tr('对话会出现在这里') })]));
    ui.agentNavRecent.parentElement.hidden = false;
    disabled();
  }
  async function transitionLayout(update, options) {
    setTransitioning(true);
    try { await motion.layout(update, options); }
    finally { setTransitioning(false); }
  }
  function showHandoff({ paperLabel = '', scopeLabel = '' } = {}) {
    handoffClosing = false;
    handoffVersion++;
    handoffAnimation?.cancel(); handoffAnimation = null;
    const parts = [paperLabel, scopeLabel].filter(Boolean);
    ui.agentHandoffContext.textContent = parts.join(' · ');
    ui.agentHandoffContext.title = parts.join(' · ');
    ui.agentHandoff.hidden = false;
    ui.agentHandoff.style.removeProperty('pointer-events');
    positionHandoff();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && typeof ui.agentHandoff.animate === 'function') {
      handoffAnimation = ui.agentHandoff.animate([
        { opacity: 0, transform: 'translateY(9px) scale(.985)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ], { duration: 220, easing: 'cubic-bezier(.22, .8, .25, 1)' });
    }
  }
  function hideHandoff() {
    if (handoffClosing && view !== 'closed') return;
    const revision = ++handoffVersion;
    handoffAnimation?.cancel(); handoffAnimation = null;
    const hide = () => {
      if (revision !== handoffVersion) return;
      ui.agentHandoff.hidden = true;
      ui.agentHandoffLayer.hidden = true;
      handoffClosing = false;
      handoffAnimation?.cancel(); handoffAnimation = null;
    };
    ui.agentHandoff.style.pointerEvents = 'none';
    if (view === 'closed' || ui.agentHandoffLayer.hidden || ui.agentHandoff.hidden
      || matchMedia('(prefers-reduced-motion: reduce)').matches || typeof ui.agentHandoff.animate !== 'function') {
      hide(); return;
    }
    handoffClosing = true;
    handoffAnimation = ui.agentHandoff.animate([
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(7px) scale(.975)' },
    ], { duration: 160, easing: 'ease-in', fill: 'forwards' });
    void handoffAnimation.finished.then(hide, () => {});
  }
  // Anchor to the content viewport, not its scroll position. This sibling layer survives
  // renderCol replacing the area children and never covers the composer or session bar.
  function positionHandoff() {
    if (handoffFrame) return;
    handoffFrame = requestAnimationFrame(() => {
      handoffFrame = 0;
      const area = ui.aiArea, layer = ui.agentHandoffLayer;
      const visible = !ui.agentHandoff.hidden && view !== 'closed' && area.offsetWidth > 0 && area.offsetHeight > 0;
      layer.hidden = !visible;
      if (!visible) return;
      layer.style.left = `${area.offsetLeft}px`;
      layer.style.top = `${area.offsetTop}px`;
      layer.style.width = `${area.offsetWidth}px`;
      layer.style.height = `${area.offsetHeight}px`;
    });
  }
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(positionHandoff);
    observer.observe(ui.aiArea);
    observer.observe(ui.sessHistory);
    observer.observe(ui.rightSide);
  }
  new MutationObserver(positionHandoff).observe(ui.rightSide, {
    attributes: true, attributeFilter: ['data-sess-view', 'data-active-panel'],
  });
  window.addEventListener('resize', positionHandoff);

  async function refreshPapers() {
    const revision = ++paperRevision;
    let papers;
    try { papers = await getPapers(); }
    catch (error) { if (revision === paperRevision) status(String(error?.message || tr('无法读取书架，请重试。'))); return; }
    if (revision !== paperRevision) return;
    const query = String(ui.agentPaperSearch.value || '').trim().toLocaleLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const rows = (Array.isArray(papers) ? papers : []).filter(paper => {
      const text = [paper.label, paper.title, paper.name, paper.path, paper.folder].filter(Boolean).join(' ').toLocaleLowerCase();
      return words.every(word => text.includes(word));
    });
    ui.agentPaperList.replaceChildren();
    if (!rows.length) {
      ui.agentPaperList.append(el('div', { class: 'agent-paper-empty', text: query
        ? tr('没有匹配的论文名称。试试文件名或文件夹。') : tr('书架里还没有论文。可以先回到书架导入 PDF。') }));
      return;
    }
    for (const paper of rows) {
      const label = String(paper.label || paper.title || paper.name || paper.path || tr('未命名论文'));
      const path = String(paper.path || paper.name || '');
      const folder = paper.folder || (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
      const row = el('button', { type: 'button', class: 'agent-paper-row',
        dataset: { agentPaper: path || paper.docId || '' }, title: path,
        onclick: () => act(async () => {
          await onOpenPaper?.(paper, row);
          closePapers();
        }) },
      iconEl('book'), el('span', { class: 'agent-paper-row-text' },
        el('span', { class: 'agent-paper-row-title', text: label }),
        folder ? el('span', { class: 'agent-paper-row-folder', text: folder }) : null), iconEl('chevron-right'));
      row.disabled = busy || transitioning;
      ui.agentPaperList.append(row);
    }
  }

  function captureRect() {
    const rect = ui.rightSide.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  }
  async function animateFrom(from) {
    animation?.cancel(); animation = null;
    const to = captureRect();
    if (!from || !to || matchMedia('(prefers-reduced-motion: reduce)').matches || typeof ui.rightSide.animate !== 'function') {
      setTransitioning(false); return;
    }
    const dx = from.x - to.x, dy = from.y - to.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(from.width - to.width) < 1) {
      setTransitioning(false); return;
    }
    setTransitioning(true);
    const scale = to.width / ui.rightSide.offsetWidth || 1;
    const current = ui.rightSide.animate([
      { transformOrigin: 'top left', transform: `translate(${dx / scale}px, ${dy / scale}px) scale(${from.width / to.width}, ${from.height / to.height})` },
      { transformOrigin: 'top left', transform: 'translate(0, 0) scale(1, 1)' },
    ], { duration: 320, easing: 'cubic-bezier(.22, .8, .25, 1)', fill: 'none' });
    animation = current;
    try { await current.finished; } catch { /* A newer navigation superseded this transition. */ }
    if (animation === current) { animation = null; setTransitioning(false); }
  }

  const navigate = action => {
    if (typeof action !== 'function') return;
    try { Promise.resolve(action()).catch(error => status(String(error?.message || tr('操作失败，请重试。')))); }
    catch (error) { status(String(error?.message || tr('操作失败，请重试。'))); }
  };
  ui.agentBtn.addEventListener('click', () => navigate(onOpen));
  ui.homeAgent.addEventListener('click', () => navigate(onOpen));
  ui.agentExpand.addEventListener('click', () => act(onExpand));
  ui.agentLandingBack.addEventListener('click', () => act(onLanding));
  ui.agentContinue.addEventListener('click', () => act(onContinue));
  ui.agentRestore.addEventListener('click', () => act(onRestore));
  ui.agentNew.addEventListener('click', () => act(onNew));
  ui.agentStartSearch.addEventListener('click', () => act(async () => { await onStartSearch?.(); ui.chatInput.focus({ preventScroll: true }); }));
  ui.agentResume.addEventListener('click', () => act(onResume));
  ui.agentHistory.addEventListener('click', () => act(onHistory));
  ui.agentNavNew.addEventListener('click', () => act(onLanding));
  ui.agentPapersToggle.addEventListener('click', () => {
    if (busy || transitioning) return;
    const open = ui.agentPaperPicker.hidden;
    if (open) onOpenPapers?.();
    closeName(); ui.agentPaperPicker.hidden = !open;
    ui.agentPapersToggle.setAttribute('aria-expanded', String(open));
    if (open) { void refreshPapers(); ui.agentPaperSearch.focus({ preventScroll: true }); }
  });
  ui.agentPapersClose.addEventListener('click', () => closePapers({ focus: true }));
  ui.agentPaperSearch.addEventListener('input', () => { void refreshPapers(); });
  ui.agentPaperSearch.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePapers({ focus: true }); }
  });
  setProfile(profile); setView(view);
  return { setView, setName, setProfile, setLanding, setTransitioning, showHandoff, hideHandoff, showNameSetup,
    hasProfileDraft: settings.isDirty, resetProfileDraft: settings.reset,
    closeNameSetup: () => closeName(), closePapers, refreshPapers, captureRect, animateFrom, setRecentConversations,
    beginPaperMotion: node => motion.begin(node), endPaperMotion: motion.end, transitionLayout };
}
