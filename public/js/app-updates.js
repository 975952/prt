import { t as tr } from './i18n.js';

const AUTO_KEY = 'reader.updates.autoCheck';
const CHECK_KEY = 'reader.updates.lastCheck';
const DAY = 24 * 60 * 60 * 1000;

/** Desktop update controls. Only an explicit click may download or install. */
export function createAppUpdates({ root, notify = () => {}, native = !!window.__PRT_WINDOW_ID,
  fetcher = (...args) => fetch(...args), storage = window.localStorage,
  postMessage = message => {
    if (typeof window.ipc?.postMessage !== 'function') throw new Error(tr('更新未完成，请重试。当前资料仍保留。'));
    window.ipc.postMessage(message);
  }, autoDelay = 10000 } = {}) {
  const nodes = Object.fromEntries(['Version', 'AutoCheck', 'Status', 'Progress', 'Check', 'Install']
    .map(name => [name.toLowerCase(), root.querySelector('#update' + name)]));
  let state = { supported: native, phase: 'idle' };
  let polling = null, automatic = null, restartTimer = null;
  let requestBusy = false, wantsInstall = false, installing = false, disposed = false;
  let checkPending = false;
  let requestVersion = 0;
  let notifiedVersion = '';
  const read = (key, fallback = '') => { try { return storage.getItem(key) ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { try { storage.setItem(key, value); } catch { /* optional preference */ } };
  nodes.autocheck.checked = read(AUTO_KEY, '1') !== '0';

  function render() {
    const supported = native && state.supported;
    const busy = requestBusy || installing || ['checking', 'downloading'].includes(state.phase);
    nodes.version.textContent = state.currentVersion
      ? tr('当前版本：{0}（{1}）', state.currentVersion, tr(state.mode === 'installed' ? '安装版' : '便携版')) : '';
    nodes.check.disabled = !supported || busy;
    nodes.autocheck.disabled = !supported;
    nodes.install.hidden = !supported || !state.availableVersion || state.phase === 'up_to_date';
    nodes.install.disabled = busy;
    nodes.install.textContent = tr(installing ? '正在重启…' : '更新并重启');
    nodes.progress.hidden = state.phase !== 'downloading';
    if (Number(state.total) > 0) {
      nodes.progress.max = Number(state.total);
      nodes.progress.value = Math.max(0, Number(state.bytes) || 0);
    } else nodes.progress.removeAttribute('value');
    nodes.status.dataset.error = String(state.phase === 'error');
    nodes.status.textContent = !supported ? tr('请使用 Windows 桌面版进行应用更新。')
      : installing ? tr('正在保存并重启，更新完成后会自动打开。')
        : state.phase === 'checking' ? tr('正在检查更新…')
          : state.phase === 'downloading' ? tr('正在下载更新…')
            : state.phase === 'ready' ? tr('更新已下载并校验，随时可以重启完成升级。')
              : state.phase === 'available' ? tr('发现新版本 {0}', state.availableVersion)
                : state.phase === 'up_to_date' ? tr('当前已是最新版本。')
                  : state.phase === 'error' ? tr('更新失败：{0}', String(state.error || tr('请稍后重试。')).slice(0, 240))
                    : tr('更新会保留论文、记忆和设置。');
  }

  function schedulePoll() {
    clearTimeout(polling);
    if (!disposed && ['checking', 'downloading'].includes(state.phase)) polling = setTimeout(() => void refresh(), 1000);
  }

  function failed(error) {
    checkPending = false;
    wantsInstall = false;
    installing = false;
    clearTimeout(restartTimer);
    state = { ...state, phase: 'error', error: error?.message || String(error) };
    render();
  }

  function installReady() {
    if (!wantsInstall || installing || state.phase !== 'ready') return;
    wantsInstall = false;
    installing = true;
    render();
    try { postMessage(JSON.stringify({ type: 'update-install' })); }
    catch (error) { failed(error); return; }
    restartTimer = setTimeout(() => failed(new Error(tr('更新未完成，请重试。当前资料仍保留。'))), 60000);
  }

  function accept(next) {
    if (disposed) return;
    state = next;
    if (state.phase === 'error') { wantsInstall = false; checkPending = false; }
    if (state.phase === 'available' && state.availableVersion !== notifiedVersion) {
      notifiedVersion = state.availableVersion;
      notify(state.availableVersion);
    }
    if (checkPending && (state.phase === 'up_to_date' || state.phase === 'available')) {
      write(CHECK_KEY, String(Date.now()));
      checkPending = false;
    }
    render();
    schedulePoll();
    installReady();
  }

  async function request(path, method = 'GET') {
    const response = await fetcher(path, { method, signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error?.message || `HTTP ${response.status}`);
    return result;
  }

  async function refresh() {
    if (!native || disposed) { render(); return; }
    if (requestBusy || installing) return;
    const version = ++requestVersion;
    try {
      const next = await request('/api/update');
      if (version === requestVersion) accept(next);
    } catch (error) { if (version === requestVersion) failed(error); }
  }

  async function check() {
    if (!native || requestBusy || installing || ['checking', 'downloading'].includes(state.phase)) return;
    checkPending = true;
    requestBusy = true;
    ++requestVersion;
    render();
    try { accept(await request('/api/update/check', 'POST')); }
    catch (error) { failed(error); }
    finally { requestBusy = false; render(); }
  }

  async function update() {
    if (!native || requestBusy || installing || !state.availableVersion || ['checking', 'downloading'].includes(state.phase)) return;
    wantsInstall = true;
    if (state.phase === 'ready') { installReady(); return; }
    requestBusy = true;
    ++requestVersion;
    render();
    try { accept(await request('/api/update/download', 'POST')); }
    catch (error) { failed(error); }
    finally { requestBusy = false; render(); }
  }

  async function start() {
    await refresh();
    if (!native || state.autoCheckAllowed === false) return;
    automatic = setTimeout(() => {
      if (!disposed && nodes.autocheck.checked && Date.now() - Number(read(CHECK_KEY, '0')) >= DAY) void check();
    }, autoDelay);
  }

  const onNativeEvent = ({ detail }) => {
    if (detail?.type === 'update-error') failed(new Error(detail.message || tr('更新未完成，请重试。当前资料仍保留。')));
  };
  nodes.check.addEventListener('click', check);
  nodes.install.addEventListener('click', update);
  nodes.autocheck.addEventListener('change', () => write(AUTO_KEY, nodes.autocheck.checked ? '1' : '0'));
  window.addEventListener('prt-desktop', onNativeEvent);
  render();
  return { start, refresh, check, update, dispose() {
    disposed = true;
    clearTimeout(polling); clearTimeout(automatic); clearTimeout(restartTimer);
    window.removeEventListener('prt-desktop', onNativeEvent);
  } };
}
