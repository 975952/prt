/** Keep workspace navigation on one visual timeline, without cloning chat DOM. */
export function createAgentMotion() {
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const targets = [
    ['#rightSide', 'alina-surface'], ['#composer .composer-row', 'alina-composer'],
    ['#aiArea', 'alina-messages'], ['#agentIdentity', 'alina-identity'],
    ['#agentNav', 'alina-navigation'], ['.viewer-wrap', 'alina-paper'],
    ['#leftSide', 'alina-outline'], ['#tabBarMount', 'alina-tabs'],
    ['.viewer-foot', 'alina-tools'],
  ];
  const easing = 'cubic-bezier(.22, .76, .18, 1)';
  let transition = null, press = null, source = null, running = [];
  function begin(node = null) {
    source = node?.closest?.('.paper-discovery-local, .agent-paper-row')
      || document.activeElement?.closest('.paper-discovery-local, .agent-paper-row');
    if (!source) return;
    source.dataset.agentOpening = 'true';
    if (!reduced()) press = source.animate([
      { transform: 'scale(1)' }, { transform: 'scale(.975)', offset: .4 }, { transform: 'scale(.99)' },
    ], { duration: 230, easing, fill: 'forwards' });
  }
  function end() {
    press?.cancel(); press = null;
    if (source) delete source.dataset.agentOpening;
    source = null;
  }
  function animate(node, frames, options = {}) {
    if (!node?.getClientRects().length || !node.animate) return null;
    const animation = node.animate(frames, { duration: 560, easing, fill: 'both', ...options });
    running.push(animation);
    return animation;
  }
  async function fallback(update, prepare, direction) {
    const panel = document.querySelector('#rightSide');
    const before = panel.getBoundingClientRect();
    // update is synchronous: install the inverse in this same task, before paint.
    update();
    const after = panel.getBoundingClientRect();
    const zoom = after.width / panel.offsetWidth || 1;
    if (before.width && after.width) animate(panel, [
      { transformOrigin: 'top left', transform: `translate(${(before.x - after.x) / zoom}px, ${(before.y - after.y) / zoom}px) scale(${before.width / after.width}, ${before.height / after.height})` },
      { transformOrigin: 'top left', transform: 'translate(0, 0) scale(1, 1)' },
    ]);
    const paper = document.querySelector('.viewer-wrap');
    if (direction === 'dock') {
      // Keep the reader on the same frame as the shrinking conversation.
      for (const [selector, x, y] of [['#leftSide', -22, 0], ['#tabBarMount', 0, -9], ['.viewer-foot', 0, 12]]) {
        animate(document.querySelector(selector), [{ opacity: 0, transform: `translate(${x}px, ${y}px)` },
          { opacity: 1, transform: 'translate(0, 0)' }], { delay: 100, duration: 460 });
      }
    }
    await prepare?.();
    if (direction === 'dock') {
      animate(paper, [{ opacity: 0, transform: 'translateX(-18px) scale(.98)' },
        { opacity: 1, transform: 'translateX(0) scale(1)' }], { duration: 480 });
    } else {
      animate(document.querySelector('#agentNav'), [{ opacity: 0, transform: 'translateX(-16px)' },
        { opacity: 1, transform: 'translateX(0)' }], { duration: 440 });
    }
    await Promise.allSettled(running.map(item => item.finished));
  }
  async function layout(update, { direction = 'dock', prepare } = {}) {
    end();
    if (reduced() || document.visibilityState === 'hidden') { update(); await prepare?.(); return; }
    document.documentElement.dataset.agentMotion = direction;
    const named = targets.map(([selector, name]) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const old = node.style.viewTransitionName;
      node.style.viewTransitionName = name;
      return { node, old };
    }).filter(Boolean);
    let timeout;
    try {
      if (typeof document.startViewTransition !== 'function') {
        await fallback(update, prepare, direction);
      } else {
        transition = document.startViewTransition(() => { update(); });
        // A slow render or hidden WebView may skip the visual transition. The
        // successful layout update still stands; no second navigation is fired.
        const ready = transition.ready.catch(() => {});
        const finished = transition.finished.catch(() => {});
        timeout = setTimeout(() => transition?.skipTransition(), 5000);
        await transition.updateCallbackDone;
        const preparation = ready.then(() => prepare?.());
        const [prepResult] = await Promise.allSettled([preparation, finished]);
        if (prepResult.status === 'rejected') throw prepResult.reason;
      }
    } finally {
      clearTimeout(timeout);
      transition?.skipTransition(); transition = null;
      for (const item of running) item.cancel();
      running = [];
      for (const { node, old } of named) {
        if (old) node.style.viewTransitionName = old;
        else node.style.removeProperty('view-transition-name');
      }
      delete document.documentElement.dataset.agentMotion;
      end();
    }
  }
  return { begin, end, layout };
}
