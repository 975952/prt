import { t as tr } from './i18n.js';
import { el } from './util.js';
import { iconEl } from './icons.js';
import { DEFAULT_AGENT_PROFILE, normalizeAgentProfile, agentDisplayName } from './agent-profile.js';

/** UI only: the caller owns conversation scope, persistence, and document navigation. */
export function createAgentWorkspace({ onOpen, onBack, onExpand, onOpenPaper,
  onContinue, onRestore, onNew, getPapers = () => [], onNameChange, onNameDismiss, onProfileChange } = {}) {
  const byId = id => document.getElementById(id);
  const ui = Object.fromEntries(['agentBtn', 'homeAgent', 'agentIdentity', 'agentNameEdit', 'agentNameForm',
    'agentNameInput', 'agentNameSave', 'agentNameCancel', 'agentNameAlias', 'agentProfileDetails', 'agentPersonalityInput',
    'agentGenderSelect', 'agentGenderCustomField', 'agentGenderCustom', 'agentHabitsInput', 'agentBack', 'agentExpand', 'agentPapersToggle',
    'agentPaperPicker', 'agentPaperSearch', 'agentPaperList', 'agentPapersClose', 'agentHandoff', 'agentHandoffLayer',
    'agentHandoffContext', 'agentContinue', 'agentRestore', 'agentNew', 'agentStatus', 'rightSide', 'aiArea', 'sessHistory']
    .map(id => [id, byId(id)]));
  const defaultProfile = DEFAULT_AGENT_PROFILE;
  const limitText = (value, limit) => [...String(value ?? '').trim()].slice(0, limit).join('');
  let profile = { ...defaultProfile };
  let view = 'closed', name = profile.name, transitioning = false, busy = false, animation = null;
  let paperRevision = 0, handoffFrame = 0, handoffVersion = 0, handoffAnimation = null, handoffClosing = false;
  let firstNameSetup = false;

  for (const host of document.querySelectorAll('[data-agent-icon]')) {
    if (!host.firstElementChild) host.append(iconEl(host.dataset.agentIcon));
  }

  function status(text = '') {
    ui.agentStatus.textContent = text;
    ui.agentStatus.hidden = !text;
  }
  function disabled() {
    for (const id of ['agentBtn', 'homeAgent', 'agentBack', 'agentExpand', 'agentContinue', 'agentRestore', 'agentNew',
      'agentNameInput', 'agentNameSave', 'agentNameCancel', 'agentPersonalityInput', 'agentGenderSelect', 'agentGenderCustom', 'agentHabitsInput']) {
      ui[id].disabled = busy || transitioning;
    }
    for (const button of ui.agentPaperList.querySelectorAll('button')) button.disabled = busy || transitioning;
    ui.rightSide.setAttribute('aria-busy', String(busy || transitioning));
  }
  async function act(action, ...args) {
    if (busy || transitioning || typeof action !== 'function') return;
    busy = true; status(); disabled();
    try { return await action(...args); }
    catch (error) { status(String(error?.message || tr('操作失败，请重试。'))); }
    finally { busy = false; disabled(); }
  }
  function closeName({ focus = false } = {}) {
    firstNameSetup = false;
    ui.agentNameForm.hidden = true;
    ui.agentNameForm.style.visibility = 'hidden';
    ui.agentProfileDetails.open = false;
    ui.agentNameCancel.textContent = tr('取消');
    ui.agentNameEdit.setAttribute('aria-expanded', 'false');
    if (focus) ui.agentNameEdit.focus({ preventScroll: true });
  }
  function showNameSetup() {
    closePapers(); firstNameSetup = true;
    ui.agentNameForm.hidden = false;
    fillProfileFields(); ui.agentProfileDetails.hidden = true; ui.agentProfileDetails.open = false;
    ui.agentNameCancel.textContent = tr('先用默认名称');
    ui.agentNameEdit.setAttribute('aria-expanded', 'true');
    positionHandoff();
  }
  function dismissName() {
    const first = firstNameSetup;
    void act(async () => {
      if (first) await onNameDismiss?.();
      closeName({ focus: !first });
    });
  }
  function closePapers({ focus = false } = {}) {
    ui.agentPaperPicker.hidden = true;
    ui.agentPapersToggle.setAttribute('aria-expanded', 'false');
    if (focus) ui.agentPapersToggle.focus({ preventScroll: true });
  }
  function setName(value) {
    profile.name = limitText(value, 32) || defaultProfile.name;
    name = agentDisplayName(profile);
    for (const node of document.querySelectorAll('[data-agent-name]')) node.textContent = name;
    ui.agentNameInput.value = profile.name;
    syncNameAlias();
    ui.agentNameEdit.title = tr('编辑名字与交流方式');
    ui.agentNameEdit.setAttribute('aria-label', tr('编辑名字与交流方式'));
    ui.agentBtn.title = tr('打开{0}', name);
    ui.agentBtn.setAttribute('aria-label', tr('打开{0}', name));
    ui.homeAgent.setAttribute('aria-label', tr('打开{0}', name));
  }
  function syncNameAlias() {
    const draft = { ...profile, name: ui.agentNameInput.value.trim() || defaultProfile.name };
    ui.agentNameAlias.hidden = agentDisplayName(draft) === draft.name;
  }
  function fillProfileFields() {
    ui.agentNameInput.value = profile.name;
    ui.agentPersonalityInput.value = profile.personality;
    const knownGender = ['', '女', '男'].includes(profile.gender);
    ui.agentGenderSelect.value = knownGender ? profile.gender : 'custom';
    ui.agentGenderCustom.value = knownGender ? '' : profile.gender;
    ui.agentGenderCustomField.hidden = knownGender;
    ui.agentHabitsInput.value = profile.habits;
    syncNameAlias();
  }
  function setProfile(value = {}) {
    profile = normalizeAgentProfile(value);
    setName(profile.name); fillProfileFields();
  }
  function setView(next) {
    if (!['full', 'docked', 'closed'].includes(next)) return;
    view = next;
    document.body.classList.toggle('agent-full', next === 'full');
    document.body.classList.toggle('agent-docked', next === 'docked');
    ui.agentIdentity.hidden = next === 'closed';
    ui.agentBtn.setAttribute('aria-expanded', String(next === 'full'));
    ui.agentBtn.setAttribute('aria-current', next === 'full' ? 'page' : 'false');
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
      if (!ui.agentNameForm.hidden) {
        const anchor = area.offsetHeight > 0 ? area : ui.sessHistory;
        if (anchor.offsetWidth > 0 && anchor.offsetHeight > 0 && view !== 'closed') {
          const width = Math.max(0, Math.min(600, anchor.offsetWidth - 24));
          ui.agentNameForm.style.left = `${anchor.offsetLeft + (anchor.offsetWidth - width) / 2}px`;
          ui.agentNameForm.style.top = `${anchor.offsetTop + 8}px`;
          ui.agentNameForm.style.width = `${width}px`;
          ui.agentNameForm.style.maxHeight = `${Math.max(0, Math.min(430, anchor.offsetHeight - 16))}px`;
          ui.agentNameForm.style.visibility = 'visible';
        } else ui.agentNameForm.style.visibility = 'hidden';
      }
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
          await onOpenPaper?.(paper);
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
    const current = ui.rightSide.animate([
      { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})` },
      { transformOrigin: 'top left', transform: 'translate(0, 0) scale(1, 1)' },
    ], { duration: 320, easing: 'cubic-bezier(.22, .8, .25, 1)', fill: 'none' });
    animation = current;
    try { await current.finished; } catch { /* A newer navigation superseded this transition. */ }
    if (animation === current) { animation = null; setTransitioning(false); }
  }

  ui.agentBtn.addEventListener('click', () => act(onOpen));
  ui.homeAgent.addEventListener('click', () => act(onOpen));
  ui.agentBack.addEventListener('click', () => act(onBack));
  ui.agentExpand.addEventListener('click', () => act(onExpand));
  ui.agentContinue.addEventListener('click', () => act(onContinue));
  ui.agentRestore.addEventListener('click', () => act(onRestore));
  ui.agentNew.addEventListener('click', () => act(onNew));
  ui.agentPapersToggle.addEventListener('click', () => {
    const open = ui.agentPaperPicker.hidden;
    closeName(); ui.agentPaperPicker.hidden = !open;
    ui.agentPapersToggle.setAttribute('aria-expanded', String(open));
    if (open) { void refreshPapers(); ui.agentPaperSearch.focus({ preventScroll: true }); }
  });
  ui.agentPapersClose.addEventListener('click', () => closePapers({ focus: true }));
  ui.agentPaperSearch.addEventListener('input', () => { void refreshPapers(); });
  ui.agentPaperSearch.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePapers({ focus: true }); }
  });
  ui.agentNameEdit.addEventListener('click', () => {
    const open = ui.agentNameForm.hidden;
    firstNameSetup = false; ui.agentNameCancel.textContent = tr('取消');
    closePapers(); ui.agentNameForm.hidden = !open;
    ui.agentProfileDetails.hidden = false; ui.agentProfileDetails.open = false;
    ui.agentNameEdit.setAttribute('aria-expanded', String(open));
    if (open) {
      fillProfileFields(); positionHandoff();
      requestAnimationFrame(() => {
        if (ui.agentNameForm.hidden) return;
        ui.agentNameInput.focus({ preventScroll: true }); ui.agentNameInput.select();
      });
    }
  });
  ui.agentNameCancel.addEventListener('click', dismissName);
  ui.agentNameInput.addEventListener('input', syncNameAlias);
  ui.agentGenderSelect.addEventListener('change', () => {
    ui.agentGenderCustomField.hidden = ui.agentGenderSelect.value !== 'custom';
    if (!ui.agentGenderCustomField.hidden) ui.agentGenderCustom.focus({ preventScroll: true });
  });
  ui.agentNameForm.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissName(); }
  });
  ui.agentNameForm.addEventListener('submit', event => {
    event.preventDefault();
    void act(async () => {
      const next = {
        name: limitText(ui.agentNameInput.value, 32) || defaultProfile.name,
        personality: limitText(ui.agentPersonalityInput.value, 180),
        gender: limitText(ui.agentGenderSelect.value === 'custom' ? ui.agentGenderCustom.value : ui.agentGenderSelect.value, 40),
        habits: limitText(ui.agentHabitsInput.value, 600),
      };
      if (onProfileChange) await onProfileChange(next);
      else await onNameChange?.(next.name);
      setProfile(next); closeName({ focus: true });
    });
  });
  setProfile(profile); setView(view);
  return { setView, setName, setProfile, setTransitioning, showHandoff, hideHandoff, showNameSetup,
    closeNameSetup: () => closeName(), refreshPapers, captureRect, animateFrom };
}
