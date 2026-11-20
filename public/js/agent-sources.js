import { t as tr } from './i18n.js';
import { el } from './util.js';
import { iconEl } from './icons.js';

// Use the links the answer renderer actually produced. Each target keeps its
// original click behavior, including document ownership and quotation matching.
function sourcesFor(answer, describePaper) {
  const groups = new Map();
  for (const link of answer?.querySelectorAll('.text .page-ref') || []) {
    const page = Number(link.dataset.page);
    const end = Number(link.dataset.pageEnd || page);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(end) || end < page) continue;
    const paper = describePaper(answer.__sessionRecord, link.dataset.paper || '');
    if (!paper?.key) continue;
    if (!groups.has(paper.key)) groups.set(paper.key, { ...paper, pages: new Map() });
    const pages = groups.get(paper.key).pages;
    const key = page + '-' + end;
    const fragment = link.dataset.fragment || '';
    const previous = pages.get(key);
    if (!previous || (!previous.fragment && fragment)) pages.set(key, { key, page, end, fragment, link });
  }
  return [...groups.values()].map(group => ({ ...group,
    pages: [...group.pages.values()].sort((a, b) => a.page - b.page || a.end - b.end) }));
}

export function createAgentSources({ area, side, heading, panel, describePaper }) {
  const toggle = heading.querySelector('#agentSourcesToggle');
  const title = heading.querySelector('#agentChatTitle');
  const close = panel.querySelector('#agentSourcesClose');
  const list = panel.querySelector('#agentSourceList');
  const narrow = matchMedia('(max-width: 1050px)');
  let active = false, expanded = !narrow.matches, frame = 0;
  let selected = null, lastAnswer = null, displayed = null, signature = null, currentGroups = [];

  function render() {
    frame = 0;
    const visible = active && side.dataset.sessView !== 'history' && side.dataset.activePanel === 'chat';
    heading.hidden = !visible;
    panel.hidden = !visible || !expanded;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!visible) return;
    title.textContent = document.getElementById('sessLabel')?.textContent.trim() || tr('新对话');
    const answers = area.querySelectorAll('.ai-body > .msg.assistant');
    heading.querySelector('#agentChatMove').hidden = !area.querySelector('.ai-body > .msg');
    const latest = answers[answers.length - 1];
    if (lastAnswer !== latest || !area.contains(selected)) selected = null;
    lastAnswer = latest;
    if (panel.hidden) return;
    const answer = selected || latest;
    // While a draft is streaming its tentative page references can still be
    // removed by the citation audit. Only publish the finished answer's links.
    const pending = !!answer && answer.__sessionRecord?.status === 'pending';
    currentGroups = sourcesFor(pending ? null : answer, describePaper);
    const next = JSON.stringify([pending, currentGroups.map(({ key, label, pages }) =>
      [key, label, pages.map(({ key, fragment }) => [key, fragment])])]);
    if (displayed === answer && next === signature) return;
    const answerChanged = displayed !== answer;
    displayed = answer; signature = next;
    list.replaceChildren(...currentGroups.map((group, i) => el('section', { class: 'agent-source-paper' },
      el('h3', {}, iconEl('book', { size: 16 }), el('span', { text: group.label })),
      ...group.pages.map((source, j) => el('button', { type: 'button', class: 'agent-source-page',
        dataset: { group: i, index: j }, title: source.link.title },
        el('strong', { text: source.page === source.end ? 'p.' + source.page : 'p.' + source.page + '–' + source.end }),
        source.fragment ? el('span', { text: source.fragment }) : null, iconEl('chevron-right', { size: 14 }))))));
    if (!currentGroups.length) list.append(el('p', { class: 'agent-sources-empty', text:
      pending ? tr('回答完成后显示本轮引用。') : tr('这条回答没有引用论文页码。') }));
    if (answerChanged) list.scrollTop = 0;
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(render);
  }
  function setExpanded(on) {
    expanded = on;
    render();
  }
  function selectAnswer(node) {
    const answer = node?.closest('.ai-body > .msg.assistant');
    if (!active || !answer || !area.contains(answer)) return;
    selected = answer;
    schedule();
  }
  area.addEventListener('click', e => selectAnswer(e.target));
  area.addEventListener('focusin', e => selectAnswer(e.target));
  toggle.addEventListener('click', () => {
    setExpanded(!expanded);
    if (expanded) close.focus({ preventScroll: true });
  });
  close.addEventListener('click', () => { setExpanded(false); toggle.focus({ preventScroll: true }); });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.click(); }
  });
  list.addEventListener('click', e => {
    const button = e.target.closest('button[data-group]');
    if (!button) return;
    e.stopPropagation();
    const source = currentGroups[button.dataset.group]?.pages[button.dataset.index];
    if (source?.link.isConnected && area.contains(source.link)) source.link.click();
  });
  narrow.addEventListener('change', () => { expanded = !narrow.matches; if (active) schedule(); });
  const observer = new MutationObserver(schedule);
  return {
    setActive(on) {
      if (on === active) return;
      active = on;
      observer.disconnect();
      if (active) {
        observer.observe(area, { childList: true, subtree: true });
        observer.observe(side, { attributes: true, attributeFilter: ['data-sess-view', 'data-active-panel'] });
        observer.observe(document.getElementById('sessLabel'), { childList: true, subtree: true, characterData: true });
      } else {
        selected = lastAnswer = displayed = signature = null;
        currentGroups = [];
        list.replaceChildren();
      }
      render();
    },
    showAnswer(answer) {
      if (!active || !area.contains(answer)) return;
      render();
      selected = answer;
      setExpanded(true);
      close.focus({ preventScroll: true });
    },
  };
}
