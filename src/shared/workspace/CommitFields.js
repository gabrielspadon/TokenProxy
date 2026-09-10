'use client';
import { useEffect, useRef, useState } from 'react';
import { NumberInput, TextInput, Tooltip } from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import board from './board.module.css';

// Fields that save from the field itself: Enter or blur commits, Escape reverts,
// and there is no draft that outlives the field. The draft is React state, so a
// re-render arriving while a value is being typed cannot wipe it, and a revert
// remounts the input so the saved value is what shows. A Tooltip parent injects
// its own onBlur/onKeyDown through cloneElement, so those are chained rather
// than spread over.
function useCommitDraft(value, onCommit, parse, saved) {
  const [draft, setDraft] = useState(value ?? '');
  const [seen, setSeen] = useState(value);
  const [revision, setRevision] = useState(0);
  const sent = useRef(null);
  if (seen !== value) {
    setSeen(value);
    setDraft(value ?? '');
  }
  useEffect(() => {
    sent.current = null;
  }, [value]);
  const revert = () => {
    setDraft(value ?? '');
    setRevision((previous) => previous + 1);
  };
  // `parse` returns undefined for a draft that is not a value at all, which
  // reverts. An empty text field IS a value: clearing an alias is how an alias
  // is removed, so it commits the empty string rather than snapping back.
  // `saved` says what the stored value looks like once parsed, so a blur that
  // changed nothing commits nothing.
  const commit = () => {
    const next = parse(draft);
    if (next === undefined || next === saved(value)) {
      revert();
      return;
    }
    if (sent.current === next) return;
    sent.current = next;
    onCommit(next);
  };
  return { draft, setDraft, revision, revert, commit };
}

function handlers({ commit, revert }, onBlur, onKeyDown) {
  return {
    onBlur: (event) => {
      onBlur?.(event);
      commit();
    },
    onKeyDown: (event) => {
      onKeyDown?.(event);
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
      if (event.key === 'Escape') revert();
    },
  };
}

const number = (draft) => {
  const next = Number(draft);
  return draft === '' || !Number.isFinite(next) ? undefined : next;
};

// What counts as "already saved", so a blur that changed nothing writes
// nothing. A number never equals `null`, so a field with no saved value always
// commits. A text field holding a number arrives here as a string, so the
// saved side is compared as a string rather than by identity, which is what
// keeps a threshold from re-saving itself on every blur.
const asNumber = (value) => value ?? null;
const asText = (value) => (value == null ? '' : String(value));

export function CommitNumber({ value, onCommit, onBlur, onKeyDown, ...props }) {
  const field = useCommitDraft(value, onCommit, number, asNumber);
  return (
    <NumberInput
      key={`${value ?? ''}:${field.revision}`}
      size="xs"
      hideControls
      allowDecimal={false}
      value={field.draft}
      onChange={field.setDraft}
      {...props}
      {...handlers(field, onBlur, onKeyDown)}
    />
  );
}

export function CommitText({ value, onCommit, onBlur, onKeyDown, ...props }) {
  const field = useCommitDraft(value, onCommit, (draft) => String(draft).trim(), asText);
  return (
    <TextInput
      key={`${value ?? ''}:${field.revision}`}
      size="xs"
      value={field.draft}
      onChange={(event) => field.setDraft(event.currentTarget.value)}
      {...props}
      {...handlers(field, onBlur, onKeyDown)}
    />
  );
}

// A name reads as text until it is renamed, so a row stays a row. Escape
// abandons the edit without committing, which is why the cancelled flag exists:
// leaving the field is what saves, and Escape has to disarm that.
export function NameField({ name, label, disabled, expanded, onCommit, onOpen }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [cancelled, setCancelled] = useState(false);
  if (!editing)
    return (
      <span className={board.nameLine}>
        <button type="button" className={board.nameButton} aria-expanded={expanded} onClick={onOpen}>
          {name}
        </button>
        <Tooltip label="Rename">
          <button
            type="button"
            className={board.iconButton}
            aria-label={`Rename ${name}`}
            disabled={disabled}
            onClick={() => {
              setDraft(name);
              setCancelled(false);
              setEditing(true);
            }}
          >
            <Icon name="i-edit" />
          </button>
        </Tooltip>
      </span>
    );
  const finish = () => {
    setEditing(false);
    const next = draft.trim();
    if (!cancelled && next && next !== name) onCommit(next);
  };
  return (
    <TextInput
      size="xs"
      autoFocus
      aria-label={label || `Account name for ${name}`}
      maxLength={120}
      className={board.nameInput}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish();
        }
        if (event.key === 'Escape') {
          setCancelled(true);
          setEditing(false);
        }
      }}
    />
  );
}
