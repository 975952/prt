/** A task may stop waiting even when an underlying provider ignores abort. */
export function abortError(reason) {
  return reason?.name === 'TimeoutError' ? reason : new DOMException('Stopped', 'AbortError');
}

export function runWithDeadline(operation, { signal, timeoutMs = 30000 } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stopped);
      if (error) { controller.abort(error); reject(error); }
      else resolve(value);
    };
    const stopped = () => finish(abortError(signal.reason));
    signal?.addEventListener('abort', stopped, { once: true });
    const duration = Number(timeoutMs);
    if (Number.isFinite(duration) && duration > 0) timer = setTimeout(() => {
      finish(Object.assign(new Error('Reading timed out'), { name: 'TimeoutError' }));
    }, duration);
    Promise.resolve().then(() => {
      if (settled) throw abortError(controller.signal.reason);
      return operation(controller.signal);
    }).then(value => finish(null, value), error => finish(error));
  });
}
