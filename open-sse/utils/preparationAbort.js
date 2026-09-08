// Await non-abortable preparation seams without retaining caller listeners.
// Their owners still cancel the underlying resource when one is available.
export function waitForPreparation(promise, signal, onLateValue) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      if (settled) {
        if (onLateValue) Promise.resolve().then(() => onLateValue(value)).catch(() => {});
        return;
      }
      settled = true; signal.removeEventListener('abort', abort); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

export function preparationSignal(signal, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
