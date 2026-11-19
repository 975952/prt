/* Runs before styles/modules: no workspace is painted until boot completes. */
(() => {
  const root = document.documentElement;
  let english = true, finished = false, failed = false;
  try {
    english = localStorage.getItem('reader.locale') !== 'zh-CN';
    const id = window.__PRT_WINDOW_ID || new URL(location.href).searchParams.get('readerWindow') || 'main';
    const key = id === 'main' ? 'reader.ui' : `reader.window.${id}.reader.ui`;
    const style = JSON.parse(localStorage.getItem(key) || '{}').style || {};
    const theme = { sand: 'light', mist: 'glass', sage: 'light', fjord: 'dark', plum: 'dark', graphite: 'dark', black: 'dark',
      system: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'glass' }[style.theme] || style.theme || 'glass';
    root.dataset.theme = ['light', 'dark', 'glass'].includes(theme) ? theme : 'glass';
    let brightness = Number(style.glassBrightness) || 0;
    if ((style.appearanceVersion || 0) < 4 && Number.isFinite(Number(style.glassBrightness))) {
      const legacyDefault = (style.appearanceVersion || 0) < 2 && (!style.theme || ['glass', 'mist'].includes(style.theme)) && style.glassBrightness === 93;
      brightness = legacyDefault ? 0 : Math.round((brightness - 92) / 8 * 100);
    }
    const level = Math.min(100, Math.max(0, brightness)) / 100;
    const tone = Math.min(100, Math.max(0, Number(style.glassTone ?? 1)));
    const [a, b, t] = tone <= 20 ? [[253, 253, 253], [252, 250, 247], tone / 20]
      : [[252, 250, 247], [255, 244, 224], (tone - 20) / 80];
    const rgb = theme === 'dark' ? [28, 30, 32].map(v => v * level)
      : theme === 'light' ? [248, 245, 235].map(v => v * (.92 + level * .08) / .93)
      : a.map((v, i) => Math.round(v + (b[i] - v) * t) * (.92 + level * .08));
    root.style.setProperty('--startup-bg', `rgb(${rgb.map(v => Math.round(Math.min(255, v))).join(' ')})`);
    root.style.setProperty('--startup-fg', theme === 'dark' ? '#a7aaad' : '#636363');
  } catch { /* Storage can be unavailable; the neutral background is usable. */ }

  const update = () => {
    const message = document.getElementById('startupMessage');
    const retry = document.getElementById('startupRetry');
    if (!message || !retry) return;
    message.textContent = failed ? (english ? 'Could not finish opening.' : '暂时未能完成加载')
      : (english ? 'Opening…' : '正在打开…');
    retry.textContent = english ? 'Retry' : '重试';
    retry.hidden = !failed;
    retry.onclick = () => location.reload();
  };
  const fail = error => {
    if (finished) return;
    failed = true;
    root.dataset.startup = 'error';
    update();
    if (error) console.error('[startup]', error);
  };
  const timer = setTimeout(() => fail(), 20000);
  document.addEventListener('DOMContentLoaded', update, { once: true });
  window.__prtStartup = {
    fail,
    finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      document.getElementById('startupStatus')?.remove();
      root.removeAttribute('data-startup');
      window.dispatchEvent(new Event('prt-startup-ready'));
    },
  };
  window.addEventListener('error', event => {
    if (event.target instanceof HTMLScriptElement) fail(event.error || event.target.src);
  }, true);
})();
