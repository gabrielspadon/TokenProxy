export const STAGE_OUTCOMES = new Set(['applied', 'unchanged', 'skipped', 'failed', 'cancelled']);
export const STAGE_ERROR_CODES = new Set([
  'transform_exception', 'service_timeout', 'service_unavailable', 'service_http_error',
  'invalid_response', 'protected_content_changed', 'invalid_configuration', 'capacity_exceeded', 'caller_cancelled',
]);

export function stageErrorCode(error) {
  if (error?.name === 'TimeoutError') return 'service_timeout';
  if (STAGE_ERROR_CODES.has(error?.code)) return error.code;
  return 'transform_exception';
}

export function reportStageOutcome(diagnostics, outcome, errorCode = null) {
  if (!diagnostics || !STAGE_OUTCOMES.has(outcome)) return;
  diagnostics.outcome = outcome;
  diagnostics.errorCode = ['failed', 'cancelled'].includes(outcome)
    ? (STAGE_ERROR_CODES.has(errorCode) ? errorCode : 'transform_exception') : null;
}

// Execution and byte measurement are independent. The caller reuses each
// serialized stage boundary; rollback parsing is paid only on failure.
export function createStageGuard({ signal, rollback, onCancelled, monotonic = () => performance.now() }) {
  const outcomes = new Map();
  const durations = new Map();
  function start(stage) {
    const at = monotonic();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const elapsed = monotonic() - at;
      if (Number.isFinite(elapsed) && elapsed >= 0) durations.set(stage, (durations.get(stage) || 0) + elapsed);
    };
  }
  function report(stage, diagnostics) {
    if (!STAGE_OUTCOMES.has(diagnostics?.outcome)) return;
    const observed = {};
    reportStageOutcome(observed, diagnostics.outcome, diagnostics.errorCode);
    outcomes.set(stage, observed);
    if (observed.outcome === 'failed') throw Object.assign(new Error(observed.errorCode), { code: observed.errorCode });
  }
  function failed(stage, error) {
    rollback();
    const cancelled = signal?.aborted === true;
    const observed = { outcome: cancelled ? 'cancelled' : 'failed', errorCode: cancelled ? 'caller_cancelled' : stageErrorCode(error) };
    outcomes.set(stage, observed);
    return cancelled;
  }
  function sync(stage, fn, enabled) {
    const end = start(stage);
    try { if (arguments.length >= 3 && !enabled) return; signal?.throwIfAborted(); fn(); signal?.throwIfAborted(); }
    catch (error) {
      if (failed(stage, error)) throw error;
    } finally { end(); }
  }
  async function asyncStage(stage, fn, enabled) {
    const end = start(stage);
    try { if (arguments.length >= 3 && !enabled) return; signal?.throwIfAborted(); await fn(); signal?.throwIfAborted(); }
    catch (error) {
      if (failed(stage, error)) {
        end();
        await onCancelled(stage);
        throw error;
      }
    } finally { end(); }
  }
  function measurement(stage, ran, changed) {
    return { outcomeSource: 'execution', durationMs: durations.get(stage) ?? null,
      durationSource: durations.has(stage) ? 'monotonic' : 'unknown', ...(outcomes.get(stage) || {
      outcome: !ran ? 'skipped' : changed ? 'applied' : 'unchanged', errorCode: null,
    }) };
  }
  return { sync, async: asyncStage, report, measurement, failed, start };
}
