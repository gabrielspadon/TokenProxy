"use client";
import { useEffect, useRef } from "react";
import { Notice } from "./Notice";

// Every mutating action passes through here. It states what the action
// requires, what it changes, and whether it can be undone, before it fires.
// A refusal stays in the dialog so the operator reads it where they acted.
export function Confirm({ open, title, verb, requires, changes, undo, irreversible = false, busy = false, refusal, onConfirm, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog className="confirm" ref={ref} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); onConfirm(); }}>
        <h2>{title}</h2>
        <dl className="facts">
          <dt>Requires</dt><dd>{requires}</dd>
          <dt>Changes</dt><dd>{changes}</dd>
          <dt>Undo</dt><dd>{undo}</dd>
        </dl>
        {children}
        {refusal ? <Notice {...refusal} /> : null}
        <div className="actions">
          <button type="button" className="button quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className={irreversible ? "button danger" : "button"} disabled={busy}>{verb}</button>
        </div>
      </form>
    </dialog>
  );
}
