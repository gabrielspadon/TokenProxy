'use client';
import { useCallback, useState } from 'react';

const equal = (left, right) => String(left ?? '') === String(right ?? '');

export function useSavedDraft(saved) {
  const [state, setState] = useState(() => ({ saved, edits: {} }));
  if (Object.keys({ ...state.saved, ...saved }).some(key => !equal(state.saved[key], saved[key]))) {
    setState({ saved, edits: Object.fromEntries(Object.entries(state.edits).filter(([key, edit]) => !equal(saved[key], edit.value))) });
  }
  const values = { ...saved, ...Object.fromEntries(Object.entries(state.edits).map(([key, edit]) => [key, edit.value])) };
  const conflicts = Object.entries(state.edits).filter(([key, edit]) => !equal(saved[key], edit.baseline) && !equal(saved[key], edit.value)).map(([key]) => key);
  const set = (key, value) => setState(current => {
    const edits = { ...current.edits };
    if (equal(value, saved[key])) delete edits[key];
    else edits[key] = { baseline: current.edits[key] ? current.edits[key].baseline : saved[key], value };
    return { saved, edits };
  });
  const reset = () => setState({ saved, edits: {} });
  const forget = useCallback(keys => setState(current => ({ ...current, edits: Object.fromEntries(Object.entries(current.edits).filter(([key]) => !keys.includes(key))) })), []);
  const editedFields = Object.keys(state.edits).filter(key => !equal(saved[key], state.edits[key].value));
  return { values, set, reset, forget, conflicts, editedFields };
}
