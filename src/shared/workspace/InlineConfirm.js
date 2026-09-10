'use client';
import { useState } from 'react';
import { ActionIcon, Button, Checkbox, Text, Tooltip } from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import styles from './inlineConfirm.module.css';

// Confirmation for a destructive or reviewed act happens inline, beside the
// thing it acts on, never in a dialog, because a layer takes the evidence off
// screen at the moment it is needed. One component covers the three shapes the
// boards use:
//
//   - the pair alone: an icon control that turns into Confirm/Cancel;
//   - the pair in the caller's own row (`control="button"`), where a labelled
//     button arms and the note explains what the act costs;
//   - the reviewed act: what changes, what it requires, whether it can be
//     undone, whatever field the act needs, then Confirm/Cancel and the
//     refusal the gateway answered with.
//
// Arming is internal when the component owns a trigger and no `onArm` is
// given, external when it is, and absent when the parent decides what to
// mount.
const CONSENT =
  'I have reviewed this change and consent to the enabled content-changing transformations. Existing saved controls remain in effect.';

export function InlineConfirm({
  // The act.
  label,
  title,
  hint,
  icon,
  verb = 'Confirm',
  dismiss = 'Cancel',
  tone = 'gray',
  danger = false,
  irreversible = false,
  control = 'icon',
  role = 'group',
  submit = false,
  // Arming and progress.
  armed,
  onArm,
  disabled = false,
  busy = false,
  // What it says.
  question,
  changes,
  requires = 'a signed-in operator session on the gateway host.',
  undo,
  body,
  note,
  children,
  refusal,
  consent,
  onConsent,
  // Wiring.
  onConfirm,
  onCancel,
}) {
  const [asking, setAsking] = useState(false);
  const external = typeof onArm === 'function';
  const armable = Boolean(icon) || external;
  const open = external ? Boolean(armed) : armable ? asking : true;
  const red = danger || irreversible;
  const inline = control === 'button';

  if (armable && !open) {
    const arm = external ? onArm : () => setAsking(true);
    if (inline)
      return (
        <Button
          size="xs"
          variant={red ? 'light' : 'default'}
          color={red ? 'red' : undefined}
          leftSection={icon ? <Icon name={icon} /> : null}
          disabled={disabled}
          onClick={arm}
        >
          {label}
        </Button>
      );
    return (
      <Tooltip label={hint || label}>
        <ActionIcon
          variant="subtle"
          color={tone}
          aria-label={label}
          disabled={disabled}
          onClick={arm}
        >
          <Icon name={icon} />
        </ActionIcon>
      </Tooltip>
    );
  }

  const close = () => {
    if (!external) setAsking(false);
  };
  const said = Boolean(title || question || changes);
  const name = title || question || (label ? `Confirm: ${label}` : undefined);
  const pair = (
    <>
      <Button
        type={submit ? 'submit' : 'button'}
        size={inline ? 'xs' : 'compact-xs'}
        variant={!inline && !said ? 'light' : undefined}
        color={red ? 'red' : said || inline ? undefined : tone === 'gray' ? 'orange' : tone}
        loading={busy}
        disabled={disabled}
        aria-label={inline ? `Confirm ${String(label).toLowerCase()}` : undefined}
        onClick={
          submit
            ? undefined
            : () => {
                close();
                onConfirm?.();
              }
        }
      >
        {inline ? 'Confirm' : verb}
      </Button>
      <Button
        type="button"
        size={inline ? 'xs' : 'compact-xs'}
        variant="default"
        disabled={busy}
        onClick={() => {
          close();
          onCancel?.();
        }}
      >
        {dismiss}
      </Button>
      {note ? (
        <Text size="xs" c="dimmed" className={styles.note}>
          {note}
        </Text>
      ) : null}
    </>
  );

  // The armed pair stands in the caller's own row of controls, so it brings no
  // wrapper of its own and nothing to say beyond its note.
  if (inline) return pair;

  if (!said)
    return (
      <span className={styles.pair} role={role} aria-label={name}>
        {pair}
      </span>
    );

  const statement = (
    <>
      <p>
        {title ? <strong>{/[.?!]$/.test(title) ? title : `${title}.`}</strong> : null}{' '}
        {changes || question}
      </p>
      <p className={styles.aside}>
        Requires {requires} {irreversible ? `Cannot be undone. ${undo || ''}` : undo || ''}
      </p>
      {body ?? children}
      {onConsent ? (
        <Checkbox
          size="xs"
          mt="xs"
          mb="xs"
          checked={Boolean(consent)}
          onChange={(event) => onConsent(event.currentTarget.checked)}
          label={CONSENT}
        />
      ) : null}
      <span className={styles.actions}>{pair}</span>
      {refusal ? (
        <p className={`${styles.deny} notice`} data-tone={refusal.tone || 'bad'} role="alert">
          <strong>{refusal.title}</strong> {refusal.next} {refusal.detail}
        </p>
      ) : null}
    </>
  );

  if (submit)
    return (
      <form
        className={styles.ask}
        role={role}
        aria-label={name}
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm?.();
        }}
      >
        {statement}
      </form>
    );
  return (
    <div className={styles.ask} role={role} aria-label={name}>
      {statement}
    </div>
  );
}
