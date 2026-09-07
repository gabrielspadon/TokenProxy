'use client';
import { createContext, useContext, useMemo, useState } from 'react';

const ObservationContext = createContext(null);
export function ObservationProvider({ children }) {
  const [mode, setMode] = useState('summary');
  const [historical, setHistorical] = useState(false);
  const [snapshot, setSnapshot] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pausedAt, setPausedAt] = useState(null);
  const value = useMemo(() => ({
    mode, historical, snapshot, revision, pausedAt,
    background: mode === 'live' && !historical && !snapshot,
    setMode(next) {
      if (!['summary','live','paused'].includes(next)) return;
      setMode(next);setPausedAt(next === 'paused' ? new Date().toISOString() : null);
    },
    setHistorical, setSnapshot,
    refresh: () => setRevision(previous => previous + 1),
  }), [mode, historical, snapshot, revision, pausedAt]);
  return <ObservationContext.Provider value={value}>{children}</ObservationContext.Provider>;
}

// Outside the operator shell, existing hook consumers keep their own behavior.
export const useObservationPolicy = () => useContext(ObservationContext);
