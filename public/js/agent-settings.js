import { t as tr } from './i18n.js';
import { DEFAULT_AGENT_PROFILE, normalizeAgentProfile, agentDisplayName } from './agent-profile.js';
import { Settings, streamChat } from './ai.js';
import { AGENT_CARD_QUESTIONS, cardGenerationMessages, parseAgentCard } from './agent-card.js';
import { modelSetupReply, isModelSetupError } from './model-onboarding.js';

/** The global settings pane is the only editor for the shared agent identity. */
export function createAgentSettings({ onSave, onConfigureModel } = {}) {
  const ui = Object.fromEntries(['agentProfileForm', 'agentNameInput', 'agentNameAlias', 'agentPersonalityInput',
    'agentGenderSelect', 'agentGenderCustomField', 'agentGenderCustom', 'agentHabitsInput',
    'agentProfileSave', 'agentProfileReset', 'agentProfileStatus', 'agentRoleEnabled', 'agentDescriptionInput', 'agentExamplesInput',
    'agentCardBuilder', 'agentCardConversation', 'agentCardInput', 'agentCardAsk', 'agentCardSend', 'agentCardGenerate',
    'agentCardStop', 'agentCardClear', 'agentCardStatus'].map(id => [id, document.getElementById(id)]));
  let profile = { ...DEFAULT_AGENT_PROFILE }, saving = false;
  let controller = null, history = [], guideStep = 0;
  function draft() {
    return normalizeAgentProfile({ name: ui.agentNameInput.value, personality: ui.agentPersonalityInput.value,
      gender: ui.agentGenderSelect.value === 'custom' ? ui.agentGenderCustom.value : ui.agentGenderSelect.value,
      habits: ui.agentHabitsInput.value, enabled: ui.agentRoleEnabled.checked,
      description: ui.agentDescriptionInput.value, examples: ui.agentExamplesInput.value });
  }
  const isDirty = () => JSON.stringify(draft()) !== JSON.stringify(profile);
  function sync() {
    ui.agentNameAlias.hidden = agentDisplayName(draft()) === draft().name;
    ui.agentGenderCustomField.hidden = ui.agentGenderSelect.value !== 'custom';
    for (const control of ui.agentProfileForm.querySelectorAll('input,select,textarea,button')) control.disabled = saving || !!controller;
    ui.agentCardStop.hidden = !controller;
    ui.agentCardStop.disabled = !controller;
    ui.agentProfileSave.disabled = saving || !!controller;
    ui.agentProfileReset.disabled = saving || !!controller || !isDirty();
    ui.agentCardSend.disabled ||= !ui.agentCardInput.value.trim();
    ui.agentCardGenerate.disabled ||= !ui.agentCardInput.value.trim() && !history.some(message => message.role === 'user');
    ui.agentProfileSave.textContent = saving ? tr('正在保存…') : tr('保存');
    ui.agentProfileForm.setAttribute('aria-busy', String(saving || !!controller));
  }
  function fill(value = profile) {
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
    const editing = isDirty() || !!controller;
    profile = normalizeAgentProfile(value);
    if (!editing) fill();
  }
  ui.agentProfileForm.addEventListener('input', () => { ui.agentProfileStatus.textContent = ''; sync(); });
  ui.agentProfileForm.addEventListener('change', sync);
  ui.agentProfileReset.addEventListener('click', () => fill());
  ui.agentProfileForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || controller) return;
    if (!isDirty()) { document.getElementById('closeSettings')?.click(); return; }
    const next = draft(); saving = true; ui.agentProfileStatus.textContent = ''; sync();
    try { await onSave?.(next); profile = next; fill(); ui.agentProfileStatus.textContent = tr('已保存'); }
    catch (error) { ui.agentProfileStatus.textContent = String(error?.message || tr('操作失败，请重试。')); ui.agentProfileStatus.classList.add('error'); }
    finally { saving = false; sync(); }
  });

  function builderStatus(text = '', error = false) {
    ui.agentCardStatus.textContent = tr(text);
    ui.agentCardStatus.classList.toggle('error', error);
  }
  function renderConversation() {
    ui.agentCardConversation.replaceChildren(...history.map(message => {
      const node = document.createElement('div'), label = document.createElement('strong');
      node.className = 'agent-card-message'; node.dataset.role = message.role;
      label.textContent = tr(message.role === 'user' ? '你' : 'AI');
      node.append(label, document.createTextNode(message.content));
      if (message.setup) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'model-profile-button'; button.textContent = tr('设置 API Key');
        button.addEventListener('click', () => onConfigureModel?.()); node.append(document.createElement('br'), button);
      }
      return node;
    }));
    ui.agentCardConversation.scrollTop = ui.agentCardConversation.scrollHeight;
  }
  async function runBuilder(kind) {
    if (controller || saving) return;
    const input = ui.agentCardInput.value.trim();
    if (kind === 'send' && !input) return;
    // Keep the complete bounded dialogue; never silently truncate user preferences.
    if (history.reduce((n, message) => n + message.content.length, 0) + input.length > 24000) {
      builderStatus('设定对话较长，请先生成角色卡或清空后重新描述。', true); return;
    }
    if (input) { history.push({ role: 'user', content: input }); ui.agentCardInput.value = ''; renderConversation(); }
    if (kind !== 'generate') {
      if (kind === 'ask' && !input && history.at(-1)?.guide) { renderConversation(); return; }
      const content = guideStep < AGENT_CARD_QUESTIONS.length ? tr(AGENT_CARD_QUESTIONS[guideStep++])
        : tr('偏好已经收集好了。你可以继续补充，或点击“生成角色卡”，把这段对话一起交给 AI 整理。');
      history.push({ role: 'assistant', content, guide: true });
      renderConversation(); builderStatus('逐条回答即可；也可以随时生成角色卡。'); sync(); return;
    }
    if (!Settings.ready) {
      history.push({ role: 'assistant', content: modelSetupReply(), setup: true });
      renderConversation(); builderStatus(); sync(); return;
    }
    if (kind === 'generate' && !history.some(message => message.role === 'user')) return;
    const current = draft(), ctl = new AbortController(); controller = ctl;
    builderStatus('正在生成角色卡…'); sync();
    try {
      const conversation = history.filter(message => !message.setup).map(({ role, content }) => ({ role, content }));
      const messages = cardGenerationMessages(conversation, current);
      const reply = await streamChat({ messages, useAgentProfile: false, stream: false, signal: ctl.signal, idleMs: 60000 });
      if (controller !== ctl || ctl.signal.aborted) return;
      fill(parseAgentCard(reply, current));
      builderStatus('角色卡已填入下方，可继续编辑。勾选角色模式并保存后生效。');
    } catch (error) {
      if (controller === ctl && !ctl.signal.aborted) {
        if (isModelSetupError(error)) {
          history.push({ role: 'assistant', content: modelSetupReply(), setup: true });
          renderConversation(); builderStatus();
        } else builderStatus(error?.message || '操作失败，请重试。', true);
      }
    } finally {
      if (controller === ctl) { controller = null; sync(); }
    }
  }
  function stop() { controller?.abort(); controller = null; sync(); }
  ui.agentCardAsk.addEventListener('click', () => runBuilder('ask'));
  ui.agentCardSend.addEventListener('click', () => runBuilder('send'));
  ui.agentCardGenerate.addEventListener('click', () => runBuilder('generate'));
  ui.agentCardStop.addEventListener('click', () => { stop(); builderStatus('已停止，可以继续或重试。'); });
  ui.agentCardClear.addEventListener('click', () => {
    stop(); history = []; guideStep = 0; ui.agentCardInput.value = ''; renderConversation(); builderStatus(); sync();
  });
  ui.agentCardInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault(); runBuilder('send');
    }
  });
  fill();
  return { setProfile, isDirty: () => isDirty() || !!controller || !!ui.agentCardInput.value.trim(),
    reset: () => { stop(); builderStatus(); fill(); } };
}

/** A one-time invitation; all subsequent editing stays in Settings. */
export function showAgentWelcome(onCustomize) {
  const key = 'reader.agent.welcome.v1';
  try {
    if (globalThis.localStorage.getItem(key)) return;
    globalThis.localStorage.setItem(key, '1');
  } catch { return; }
  const card = document.createElement('section');
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
      card.remove();
    });
    actions.append(button);
  }
  card.append(title, detail, actions); document.body.append(card);
}
