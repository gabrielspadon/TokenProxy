'use client';
import styles from './system.module.css';

// One line of the control panel: what it is, the control or reading, and the
// word that says what the gateway holds. Rows are the unit of the System
// page; nothing on it is a card.
export function Row({ id, label, hint, control, state }) {
  return (
    <div className={styles.row} data-row={id}>
      <div className={styles.rowLabel}>
        <span>{label}</span>
        {hint ? <small title={hint}>{hint}</small> : null}
      </div>
      <div className={styles.rowControl}>{control}</div>
      <div className={styles.rowState}>{state}</div>
    </div>
  );
}
