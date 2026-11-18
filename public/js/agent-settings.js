import { t as tr } from './i18n.js';
import { DEFAULT_AGENT_PROFILE, normalizeAgentProfile, agentDisplayName } from './agent-profile.js';

/** The global settings pane is the only editor for the shared agent identity. */
export function createAgentSettings({ onSave } = {}) {
  const ui = Object.fromEntries(['agentProfileForm', 'agentNameInput', 'agentNameAlias', 'agentPersonalityInput',
    'agentGenderSelect', 'agentGenderCustomField', 'agentGenderCustom', 'agentHabitsInput',
    'agentProfileSave', 'agentProfileReset', 'agentProfileStatus'].map(id => [id, document.getElementById(id)]));
  let profile = { ...DEFAULT_AGENT_PROFILE }, saving = false;
  function draft() {
    return normalizeAgentProfile({ name: ui.agentNameInput.value, personality: ui.agentPersonalityInput.value,
      gender: ui.agentGenderSelect.value === 'custom' ? ui.agentGenderCustom.value : ui.agentGenderSelect.value,
      habits: ui.agentHabitsInput.value });
  }
  const isDirty = () => JSON.stringify(draft()) !== JSON.stringify(profile);
  function sync() {
    ui.agentNameAlias.hidden = agentDisplayName(draft()) === draft().name;
    ui.agentGenderCustomField.hidden = ui.agentGenderSelect.value !== 'custom';
    for (const control of ui.agentProfileForm.querySelectorAll('input,select,textarea,button')) control.disabled = saving;
    ui.agentProfileSave.disabled = saving || !isDirty();
    ui.agentProfileReset.disabled = saving || !isDirty();
    ui.agentProfileSave.textContent = saving ? tr('正在保存…') : tr('保存');
    ui.agentProfileForm.setAttribute('aria-busy', String(saving));
  }
  function fill() {
    ui.agentNameInput.value = profile.name;
    ui.agentPersonalityInput.value = profile.personality;
    const knownGender = ['', '女', '男'].includes(profile.gender);
    ui.agentGenderSelect.value = knownGender ? profile.gender : 'custom';
    ui.agentGenderCustom.value = knownGender ? '' : profile.gender;
    ui.agentHabitsInput.value = profile.habits;
    ui.agentProfileStatus.textContent = ''; ui.agentProfileStatus.classList.remove('error'); sync();
  }
  function setProfile(value) {
    const editing = ui.agentProfileForm.contains(document.activeElement) && isDirty();
    profile = normalizeAgentProfile(value);
    if (!editing) fill();
  }
  ui.agentProfileForm.addEventListener('input', () => { ui.agentProfileStatus.textContent = ''; sync(); });
  ui.agentProfileForm.addEventListener('change', sync);
  ui.agentProfileReset.addEventListener('click', fill);
  ui.agentProfileForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !isDirty()) return;
    const next = draft(); saving = true; ui.agentProfileStatus.textContent = ''; sync();
    try { await onSave?.(next); profile = next; fill(); ui.agentProfileStatus.textContent = tr('已保存'); }
    catch (error) { ui.agentProfileStatus.textContent = String(error?.message || tr('操作失败，请重试。')); ui.agentProfileStatus.classList.add('error'); }
    finally { saving = false; sync(); }
  });
  fill();
  return { setProfile, isDirty, reset: fill };
}
