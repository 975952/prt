'use strict';
const fields = ['model', 'baseURL', 'apiKey', 'visionModel', 'temperature', 'stream'];
const controlFields = ['profileAction', 'profileId', 'profileName', 'selectProfile'];
let writeQueue = Promise.resolve();
function withSaveLock(save) {
  const pending = writeQueue.then(save);
  writeQueue = pending.catch(() => {});
  return pending;
}
const own = (value, key) => Object.hasOwn(value, key);
function values(source = {}) {
  return Object.fromEntries(fields.map(k => [k, source[k] ?? (k === 'stream' ? true : k === 'temperature' ? 0.2 : '')]));
}
function profiles(cfg) {
  const stored = Array.isArray(cfg.modelProfiles) ? cfg.modelProfiles.filter(p => p && typeof p === 'object' && !Array.isArray(p)) : [];
  let serial = Number.isSafeInteger(cfg.modelProfileSerial) && cfg.modelProfileSerial > 0 ? cfg.modelProfileSerial : 0;
  for (const p of stored) {
    const n = /^profile-(\d+)$/.exec(p.id || '');
    if (n && Number.isSafeInteger(Number(n[1]))) serial = Math.max(serial, Number(n[1]));
  }
  const used = new Set();
  const list = stored.map(p => {
    let id = typeof p.id === 'string' && /^[\w-]{1,80}$/.test(p.id) && !used.has(p.id) ? p.id : '';
    if (!id) id = `profile-${++serial}`;
    used.add(id);
    return { ...values(p), id, name: typeof p.name === 'string' ? p.name : '' };
  });
  // Old versions stored anonymous snapshots. Preserve every entry and the current
  // credentials once; managed empty lists must stay empty after the last deletion.
  let active = list.find(p => p.id === cfg.activeProfile)?.id || '';
  if (!own(cfg, 'activeProfile')) {
    const current = values(cfg);
    active = list.find(p => fields.every(k => p[k] === current[k]))?.id || '';
    if (!active && fields.some(k => typeof current[k] === 'string' && current[k])) {
      active = `profile-${++serial}`;
      list.push({ ...current, id: active, name: '' });
    }
  }
  return { list, active, serial };
}
function publicConfig(cfg) {
  const { list, active } = profiles(cfg);
  return { ...cfg, apiKey: '', hasApiKey: !!cfg.apiKey, activeProfile: active,
    modelProfiles: list.map(({ apiKey, ...p }) => ({ ...p, hasApiKey: !!apiKey })) };
}
function saveProfiles(cur, next, raw, patch = raw) {
  const state = profiles(cur);
  const { list } = state;
  const action = own(raw, 'selectProfile') ? 'select' : raw.profileAction;
  if (action !== undefined && !['create', 'save', 'select', 'delete'].includes(action)) throw new Error('未知的模型配置操作');
  if (own(raw, 'selectProfile') && own(raw, 'profileAction')) throw new Error('一次只能执行一种模型配置操作');
  if (['delete', 'select'].includes(action) && fields.some(k => own(raw, k))) throw new Error('切换或删除配置时不能同时修改模型字段');
  const id = own(raw, 'selectProfile') ? raw.selectProfile : raw.profileId;
  const activate = (p) => {
    Object.assign(next, values(p));
    state.active = p?.id || '';
  };
  if (action === 'delete' || action === 'select' || action === 'save') {
    if (typeof id !== 'string' || !list.some(p => p.id === id)) throw new Error('模型配置不存在，请重新打开设置');
  }
  if (action === 'delete') {
    const index = list.findIndex(p => p.id === id);
    list.splice(index, 1);
    if (state.active === id) activate(list[Math.min(index, list.length - 1)]);
  } else if (action === 'select') {
    activate(list.find(p => p.id === id));
  } else if (action === 'create' || action === 'save') {
    for (const key of fields) {
      if (own(raw, key) && !own(patch, key)) throw new Error(`模型配置字段无效：${key}`);
    }
    if (own(raw, 'profileName') && (typeof raw.profileName !== 'string' || [...raw.profileName].length > 80)) throw new Error('配置名称最多 80 个字符');
    const p = action === 'save' ? list.find(p => p.id === id) : { ...values(), id: `profile-${++state.serial}`, name: '' };
    for (const key of fields) {
      if (own(patch, key) && (key !== 'apiKey' || patch.apiKey)) p[key] = patch[key];
    }
    p.model = p.model.trim();
    p.baseURL = p.baseURL.trim();
    if (!p.model || !p.baseURL) throw new Error('请填写模型名和接口地址');
    if (own(raw, 'profileName')) p.name = raw.profileName.trim();
    if (action === 'create') list.push(p);
    activate(p);
  } else if (fields.some(k => own(patch, k))) {
    // Legacy callers still update the active entry, never append a new snapshot
    // for every edit. Unrelated settings do not create or change profiles.
    let p = list.find(p => p.id === state.active);
    if (!p) { p = { id: `profile-${++state.serial}`, name: '' }; list.push(p); }
    Object.assign(p, values(next));
    activate(p);
  }
  next.modelProfiles = list;
  next.activeProfile = state.active;
  next.modelProfileSerial = state.serial;
  return next;
}
module.exports = { publicConfig, saveProfiles, controlFields, withSaveLock };
