'use client';
import styles from './system.module.css';

// One setting: its label, the control that changes it, and the state word or
// evidence line that says what the gateway now holds.
export function SettingRow({ label, control, state, hint }) {
  return (
    <div className={styles.setting}>
      <span className={styles.settingLabel} title={label}>
        {label}
      </span>
      <span className={styles.settingControl}>{control}</span>
      {state ? <span className={styles.settingState}>{state}</span> : null}
      {hint ? <small className={styles.settingHint}>{hint}</small> : null}
    </div>
  );
}

// Label on the left, the value the gateway reported on the right. A reading
// that carries no percentage gets this line rather than an empty meter.
export function FactLine({ label, value }) {
  return (
    <div className={styles.factLine}>
      <span title={label}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
