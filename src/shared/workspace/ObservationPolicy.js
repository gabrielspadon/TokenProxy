'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const OBSERVATION_MODE_KEY = 'tokenproxy.observation-mode';
export const OBSERVATION_MODES = ['summary', 'live', 'paused'];
export const DEFAULT_OBSERVATION_MODE = 'summary';

// The stored value is the internal enum, unchanged, so a preference written by
// an earlier build still reads back. Anything else -- absent, malformed, a
// value another tab or a hand edit put there -- resolves to the default, which
// is the mode that starts no recurring reads and no stream of its own.
//
// The store is acquired by calling `acquire` INSIDE the try, never passed in
// already-evaluated. Reading `window.localStorage` is itself a throwing
// operation: a SecurityError under a blocked or partitioned third-party
// context comes from the property getter, so evaluating it at the call site
// would throw past this catch, out of the mount effect below, and leave every
// consumer hydrating forever.
export function readStoredMode(acquire = () => window.localStorage) {
  try {
    const raw = acquire()?.getItem(OBSERVATION_MODE_KEY);
    return OBSERVATION_MODES.includes(raw) ? raw : DEFAULT_OBSERVATION_MODE;
  } catch {
    return DEFAULT_OBSERVATION_MODE;
  }
}

const ObservationContext = createContext(null);
export function ObservationProvider({ children }) {
  // The server and the first client render both produce the default. Reading
  // storage during render would make them disagree (React hydration #418), so
  // the stored choice arrives in an effect and `hydrated` gates it.
  const [mode, setModeState] = useState(DEFAULT_OBSERVATION_MODE);
  const [hydrated, setHydrated] = useState(false);
  const [historical, setHistorical] = useState(false);
  const [snapshot, setSnapshot] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pausedAt, setPausedAt] = useState(null);

  useEffect(() => {
    setModeState(readStoredMode());
    setHydrated(true);
    // Another tab's write applies here; a cleared or corrupted key falls back
    // to the default rather than leaving this tab on a mode nobody chose.
    const sync = (event) => {
      if (event.key !== null && event.key !== OBSERVATION_MODE_KEY) return;
      const next = readStoredMode();
      setModeState((current) => (current === next ? current : next));
      // A restored pause carries no original timestamp, so none is claimed.
      setPausedAt(null);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const setMode = useCallback((next) => {
    if (!OBSERVATION_MODES.includes(next)) return;
    setModeState(next);
    try {
      // Same reason as readStoredMode: the property access is inside the try,
      // because acquiring the store can throw before setItem is ever reached.
      window.localStorage.setItem(OBSERVATION_MODE_KEY, next);
    } catch {
      // Persistence is best effort. The session still honours the choice.
    }
    setPausedAt(next === 'paused' ? new Date().toISOString() : null);
  }, []);
  const refresh = useCallback(() => setRevision((previous) => previous + 1), []);

  const value = useMemo(() => ({
    mode, historical, snapshot, revision, pausedAt, hydrated,
    // Background work stays off until the stored mode is known. Hydrating into
    // Live for one frame would open a subscription the operator had paused.
    // `hydrated` becomes true even when the store is unreadable, so an
    // unreachable localStorage costs the operator the saved preference, never
    // the workspace.
    background: hydrated && mode === 'live' && !historical && !snapshot,
    setMode, setHistorical, setSnapshot, refresh,
  }), [mode, historical, snapshot, revision, pausedAt, hydrated, setMode, refresh]);
  return <ObservationContext.Provider value={value}>{children}</ObservationContext.Provider>;
}

// Outside the operator shell, existing hook consumers keep their own behavior.
export const useObservationPolicy = () => useContext(ObservationContext);
