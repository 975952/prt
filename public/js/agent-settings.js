import { t as tr, locale } from './i18n.js';
import { AGENT_PROFILE_KEY, DEFAULT_AGENT_PROFILE, normalizeAgentProfile, agentDisplayName, readAgentProfile } from './agent-profile.js';
import { Settings, streamChat } from './ai.js';
import { AGENT_CARD_QUESTIONS, AGENT_CARD_CHOICES, cardGenerationMessages, parseAgentCard } from './agent-card.js';
import { modelSetupReply, isModelSetupError } from './model-onboarding.js';

/** All character editing stays inside Settings; the interview is collected locally. */
export function createAgentSettings({ onSave, onConfigureModel } = {}) {
  const ui = Object.fromEntries([...document.querySelectorAll('#agentProfileForm [id], #agentProfileForm, .agent-profile-footer [id]')]
    .map(node => [node.id, node]));
  let profile = normalizeAgentProfile(DEFAULT_AGENT_PROFILE), saving = false, controller = null;
  let view = 'overview', customized = false, step = 0, answers = [], extra = '';

  function draft() {
    return normalizeAgentProfile({ name: ui.agentNameInput.value, personality: ui.agentPersonalityInput.value,
      gender: ui.agentGenderSelect.value === 'custom' ? ui.agentGenderCustom.value : ui.agentGenderSelect.value,
      habits: ui.agentHabitsInput.value, enabled: ui.agentRoleEnabled.checked, customized,
      description: ui.agentDescriptionInput.value, examples: ui.agentExamplesInput.value });
  }
  const isDirty = () => Object.entries(draft()).some(([key, value]) => value !== profile[key]);
  function expandFields() {
    for (const field of ui.agentProfileForm.querySelectorAll('textarea')) {
      if (!field.getClientRects().length) continue;
      const scrollPane = document.querySelector('.settings-panes'), top = scrollPane.scrollTop;
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight + 2}px`;
      scrollPane.scrollTop = top;
    }
  }
  // Reflow when Settings opens, switches categories or changes window width.
  new ResizeObserver(expandFields).observe(ui.agentProfileForm);
  function sync() {
    const value = draft(), busy = saving || !!controller;
    ui.agentNameAlias.hidden = agentDisplayName(value) === value.name;
    ui.agentGenderCustomField.hidden = ui.agentGenderSelect.value !== 'custom';
    ui.agentCardOverview.hidden = view !== 'overview';
    ui.agentCardBuilder.hidden = view !== 'builder';
    ui.agentCardEditor.hidden = view !== 'editor';
    ui.agentModeCard.hidden = view === 'builder';
    ui.agentCustomize.hidden = customized;
    ui.agentExistingCard.hidden = !customized;
    ui.agentPreviewName.textContent = value.name;
    ui.agentPreviewMonogram.textContent = [...value.name][0];
    ui.agentPreviewPersonality.textContent = value.personality || tr('属于你的交流风格');
    ui.agentPreviewState.textContent = tr(isDirty() ? '未保存的修改' : value.enabled ? '人格模式已开启' : '角色卡已保存 · 模式未开启');
    ui.agentModeCard.dataset.enabled = String(value.enabled);
    for (const control of ui.agentProfileForm.querySelectorAll('input,select,textarea,button')) control.disabled = busy;
    ui.agentCardStop.hidden = !controller;
    ui.agentCardStop.disabled = !controller;
    ui.agentProfileSave.disabled = busy || view === 'builder' || !isDirty();
    ui.agentProfileReset.disabled = busy || !(isDirty() || answers.length || extra || ui.agentCardInput.value);
    ui.agentCardPrevious.disabled ||= step === 0;
    ui.agentCardNext.disabled ||= !(answers[step]?.choice || ui.agentCardInput.value.trim());
    ui.agentCardGenerate.disabled ||= !hasAnswers();
    ui.agentProfileSave.textContent = saving ? tr('正在保存…') : tr('保存');
    ui.agentProfileForm.setAttribute('aria-busy', String(busy));
    expandFields();
  }
  function fill(value = profile) {
    customized = value.customized === true;
    ui.agentNameInput.value = value.name;
    ui.agentPersonalityInput.value = value.personality;
    const knownGender = ['', '女', '男'].includes(value.gender);
    ui.agentGenderSelect.value = knownGender ? value.gender : 'custom';
    ui.agentGenderCustom.value = knownGender ? '' : value.gender;
    ui.agentHabitsInput.value = value.habits;
    ui.agentRoleEnabled.checked = value.enabled;
    ui.agentDescriptionInput.value = value.description;
    ui.agentExamplesInput.value = value.examples;
    ui.agentProfileStatus.textContent = ''; ui.agentProfileStatus.classList.remove('error'); sync();
  }
  function setProfile(value) {
    const editing = isDirty() || !!controller || saving;
    profile = normalizeAgentProfile(value);
    if (!editing) fill();
  }
  function showView(next) {
    view = next; sync();
    document.querySelector('.settings-panes').scrollTop = 0;
    const target = next === 'builder' ? (step < AGENT_CARD_QUESTIONS.length ? ui.agentCardQuestion : ui.agentReviewTitle)
      : next === 'editor' ? ui.agentNameInput : customized ? ui.agentViewCard : ui.agentCustomize;
    target.focus({ preventScroll: true });
  }
  ui.agentProfileForm.addEventListener('input', () => { ui.agentProfileStatus.textContent = ''; sync(); });
  ui.agentProfileForm.addEventListener('change', sync);
  ui.agentProfileForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || controller || view === 'builder' || !isDirty()) return;
    const next = draft(); saving = true; ui.agentProfileStatus.textContent = ''; sync();
    try {
      await onSave?.(next); profile = next; fill(); clearInterview(); showView('overview');
      ui.agentProfileStatus.textContent = tr('已保存');
    } catch (error) {
      ui.agentProfileStatus.textContent = String(error?.message || tr('操作失败，请重试。'));
      ui.agentProfileStatus.classList.add('error');
    } finally { saving = false; sync(); }
  });

  function builderStatus(text = '', error = false) {
    ui.agentCardStatus.textContent = tr(text);
    ui.agentCardStatus.classList.toggle('error', error);
  }
  function answerText(answer) {
    return [answer?.choice, answer?.text?.trim()].filter(Boolean).join('；');
  }
  function captureAnswer() {
    if (step === AGENT_CARD_QUESTIONS.length) extra = ui.agentCardInput.value;
    else answers[step] = { ...answers[step], text: ui.agentCardInput.value };
  }
  function hasAnswers() {
    return !!(ui.agentCardInput.value.trim() || extra.trim() || answers.some(answer => answerText(answer)));
  }
  function renderQuestion(focus = false) {
    const review = step === AGENT_CARD_QUESTIONS.length;
    ui.agentQuestionPanel.hidden = review; ui.agentCardReview.hidden = !review;
    ui.agentCardProgress.textContent = review ? tr('确认偏好') : tr('第 {0} / {1} 题', step + 1, AGENT_CARD_QUESTIONS.length);
    ui.agentCardProgressBar.style.width = ((review ? 1 : (step + 1) / AGENT_CARD_QUESTIONS.length) * 100) + '%';
    ui.agentCardPrevious.hidden = false;
    ui.agentCardSkip.hidden = review; ui.agentCardNext.hidden = review;
    ui.agentCardGenerate.classList.toggle('agent-primary', review);
    ui.agentCardInputLabel.textContent = tr(review ? '还有想补充的吗？（可选）' : '或用自己的话说');
    ui.agentCardInput.value = review ? extra : answers[step]?.text || '';
    ui.agentCardChoices.replaceChildren();
    if (!review) {
      ui.agentCardQuestion.textContent = tr(AGENT_CARD_QUESTIONS[step]);
      for (const choice of AGENT_CARD_CHOICES[step]) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'agent-persona-choice'; button.textContent = tr(choice);
        button.setAttribute('aria-pressed', String(answers[step]?.choice === tr(choice)));
        button.addEventListener('click', () => {
          captureAnswer();
          answers[step] = { ...answers[step], choice: answers[step]?.choice === tr(choice) ? '' : tr(choice) };
          for (const item of ui.agentCardChoices.children) item.setAttribute('aria-pressed', String(item.textContent === answers[step].choice));
          sync();
        });
        ui.agentCardChoices.append(button);
      }
    } else {
      ui.agentReviewAnswers.replaceChildren(...AGENT_CARD_QUESTIONS.map((question, index) => {
        const button = document.createElement('button'), label = document.createElement('span'), answer = document.createElement('strong');
        button.type = 'button'; button.className = 'agent-review-answer';
        label.textContent = tr(question); answer.textContent = answerText(answers[index]) || tr('已跳过');
        button.append(label, answer); button.title = tr('点击修改');
        button.addEventListener('click', () => { captureAnswer(); step = index; renderQuestion(true); });
        return button;
      }));
    }
    builderStatus(); sync();
    if (focus) (review ? ui.agentReviewTitle : ui.agentCardQuestion).focus({ preventScroll: true });
  }
  function clearInterview() {
    step = 0; answers = []; extra = ''; ui.agentCardInput.value = '';
    ui.agentCardConversation.replaceChildren(); builderStatus(); renderQuestion();
  }
  function setupReply() {
    const node = document.createElement('div'), label = document.createElement('strong'), button = document.createElement('button');
    node.className = 'agent-card-message'; node.dataset.role = 'assistant';
    label.textContent = 'AI'; button.type = 'button'; button.className = 'model-profile-button';
    button.textContent = tr('设置 API Key'); button.addEventListener('click', () => onConfigureModel?.());
    node.append(label, document.createTextNode(modelSetupReply()), document.createElement('br'), button);
    ui.agentCardConversation.replaceChildren(node); builderStatus(); sync();
    node.scrollIntoView({ block: 'nearest' });
  }
  async function generate() {
    if (controller || saving) return;
    captureAnswer();
    if (!hasAnswers()) { sync(); return; }
    if (!Settings.ready) { setupReply(); return; }
    const history = [];
    for (let index = 0; index < answers.length; index++) {
      if (!answers[index]) continue;
      history.push({ role: 'assistant', content: tr(AGENT_CARD_QUESTIONS[index]) },
        { role: 'user', content: answerText(answers[index]) || tr('跳过，保留当前设定。') });
    }
    if (extra.trim()) history.push({ role: 'user', content: extra.trim() });
    const current = draft(), ctl = new AbortController(); controller = ctl;
    ui.agentCardConversation.replaceChildren(); builderStatus('正在生成角色卡…'); sync();
    try {
      const reply = await streamChat({ messages: cardGenerationMessages(history, current), useAgentProfile: false,
        outputLanguage: locale, stream: false, signal: ctl.signal, idleMs: 60000 });
      if (controller !== ctl || ctl.signal.aborted) return;
      fill({ ...parseAgentCard(reply, current), customized: true });
      controller = null; showView('editor');
      ui.agentProfileStatus.textContent = tr('角色卡已生成，编辑并保存即可。');
    } catch (error) {
      if (controller === ctl && !ctl.signal.aborted) {
        if (isModelSetupError(error)) setupReply();
        else builderStatus(error?.message || '操作失败，请重试。', true);
      }
    } finally { if (controller === ctl) controller = null; sync(); }
  }
  function stop() { controller?.abort(); controller = null; sync(); }
  function reset() { stop(); fill(); clearInterview(); view = 'overview'; sync(); }
  ui.agentProfileReset.addEventListener('click', () => { reset(); showView('overview'); });
  for (const button of [ui.agentCustomize, ui.agentDesign]) button.addEventListener('click', () => { renderQuestion(); showView('builder'); });
  ui.agentViewCard.addEventListener('click', () => showView('editor'));
  ui.agentWriteCard.addEventListener('click', () => { captureAnswer(); customized = true; showView('editor'); });
  ui.agentEditorBack.addEventListener('click', () => showView('overview'));
  ui.agentBuilderBack.addEventListener('click', () => { captureAnswer(); showView('overview'); });
  ui.agentCardNext.addEventListener('click', () => { captureAnswer(); step++; renderQuestion(true); });
  ui.agentCardPrevious.addEventListener('click', () => { captureAnswer(); step = Math.max(0, step - 1); renderQuestion(true); });
  ui.agentCardSkip.addEventListener('click', () => { answers[step] = { choice: '', text: '' }; step++; renderQuestion(true); });
  ui.agentCardGenerate.addEventListener('click', generate);
  ui.agentCardStop.addEventListener('click', () => { stop(); builderStatus('已停止，可以继续或重试。'); });
  ui.agentCardClear.addEventListener('click', () => { clearInterview(); renderQuestion(true); });
  ui.agentCardInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      if (step < AGENT_CARD_QUESTIONS.length && !ui.agentCardNext.disabled) ui.agentCardNext.click();
      else if (step === AGENT_CARD_QUESTIONS.length) generate();
    }
  });
  fill(); renderQuestion();
  return { setProfile, isDirty: () => isDirty() || !!controller || answers.some(answer => answerText(answer)) || !!extra.trim() || !!ui.agentCardInput.value.trim(), reset };
}


/** A one-time invitation; all subsequent editing stays in Settings. */
export function showAgentWelcome(onCustomize) {
  const key = 'reader.agent.welcome.v1';
  if (document.getElementById('agentWelcome') || readAgentProfile().customized) return;
  try {
    // Older versions wrote '1' before the reader had a chance to respond.
    if (localStorage.getItem(key) === 'acknowledged') return;
  } catch { /* The invitation still works for this window without storage. */ }
  const card = document.createElement('section');
  function dismiss() {
    window.removeEventListener('storage', onStorage);
    card.remove();
  }
  function onStorage(event) {
    if ((event.key === key && event.newValue === 'acknowledged')
      || (event.key === AGENT_PROFILE_KEY && readAgentProfile().customized)) dismiss();
  }
  card.id = 'agentWelcome'; card.className = 'agent-welcome';
  card.setAttribute('aria-labelledby', 'agentWelcomeTitle');
  const title = document.createElement('h2'), detail = document.createElement('p'), actions = document.createElement('div');
  title.id = 'agentWelcomeTitle'; title.textContent = tr('定制你的 AI 助手');
  detail.textContent = tr('设定喜欢的性格与交流方式，也可以直接跳过。以后可在设置 → 智能体中修改。');
  actions.className = 'agent-settings-actions';
  for (const [id, text, customize] of [['agentWelcomeCustomize', '开始定制', true], ['agentWelcomeSkip', '直接跳过', false]]) {
    const button = document.createElement('button'); button.id = id; button.type = 'button';
    button.className = 'model-profile-button'; button.textContent = tr(text);
    button.addEventListener('click', async () => {
      if (customize) { await onCustomize(); }
      try { localStorage.setItem(key, 'acknowledged'); } catch { /* Dismiss locally. */ }
      dismiss();
    });
    actions.append(button);
  }
  window.addEventListener('storage', onStorage);
  card.append(title, detail, actions); document.body.append(card);
}
