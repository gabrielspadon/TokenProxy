'use client';
import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Autocomplete,
  Button,
  Group,
  Select,
  Text,
  Tooltip,
} from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import { useResource } from '@/shared/workspace/useResource';
import { useConfiguredModels } from '@/shared/workspace/useConfiguredModels';
import { call } from '@/shared/api';
import board from '@/shared/workspace/board.module.css';
import styles from './policy.module.css';

const CLASSES = ['simple', 'coding', 'reasoning'];
const show = (value) => value || 'Use catalog ranking';
const valid = (value) =>
  !value ||
  (typeof value === 'string' &&
    value.indexOf('/') > 0 &&
    !value.endsWith('/') &&
    !/\s/.test(value) &&
    value.length <= 512);

export function AutoRouting() {
  const resource = useResource('/api/admin/auto-routing');
  const [draft, setDraft] = useState(null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const values = draft?.rules || resource.data?.rules || {};
  const { options } = useConfiguredModels(CLASSES.map((key) => values[key]));
  const ok = CLASSES.every((key) => valid(values[key]));

  function discard() {
    setDraft(null);
    setReview(false);
    setBlocked(false);
    setConflict(false);
  }
  async function refreshRules() {
    if (busy) return;
    if (!draft || blocked) {
      resource.refresh();
      return;
    }
    setBusy(true);
    const current = await call('/api/admin/auto-routing');
    if (current.ok && current.body?.currentHash && current.body?.rules) {
      setDraft((previous) => previous && { ...previous, before: current.body });
      setReview(false);
      setConflict(false);
      setFeedback({
        error: false,
        message:
          'Latest saved rules loaded. Your intended rules are retained. Review the updated before and after values before saving.',
      });
    } else {
      setFeedback({
        error: true,
        message:
          'Latest rules could not be read. Your draft is retained; refresh successfully before reviewing again.',
      });
      setReview(false);
      setConflict(true);
    }
    resource.refresh();
    setBusy(false);
  }
  async function save() {
    if (busy || blocked || conflict || !review || !draft || !ok) return;
    setBusy(true);
    setFeedback(null);
    const result = await call('/api/admin/auto-routing', {
      method: 'POST',
      body: {
        rules: Object.fromEntries(CLASSES.map((key) => [key, draft.rules[key] || null])),
        expectedCurrent: draft.before.currentHash,
      },
    });
    if (!result.ok) {
      setFeedback({
        error: true,
        message:
          result.status === 409
            ? 'Rules changed after review. Refresh and review your retained draft again.'
            : 'Rules were not confirmed. Inspect current state before another mutation.',
      });
      if (result.status === 409) {
        setConflict(true);
        setReview(false);
      }
      setBlocked(result.status === 0 || result.status >= 500);
      setBusy(false);
      return;
    }
    const current = await call('/api/admin/auto-routing');
    const retained = result.body.receipt
      ? await call(`/api/admin/auto-routing/receipts/${result.body.receipt.id}`)
      : null;
    const confirmed =
      result.status !== 207 &&
      result.body.persistence === 'confirmed' &&
      current.ok &&
      current.body.currentHash === result.body.currentHash &&
      (!result.body.receipt ||
        (retained?.ok && retained.body.afterHash === result.body.currentHash));
    setFeedback({
      error: !confirmed,
      message: confirmed
        ? 'Automatic routing rules saved and verified.'
        : 'Rules accepted, but persisted readback is incomplete. Inspect current state before another mutation.',
    });
    setReceipt(retained?.ok ? retained.body : result.body.receipt || null);
    if (confirmed) discard();
    else setBlocked(true);
    resource.refresh();
    setBusy(false);
  }
  async function inspect(id) {
    const result = await call(`/api/admin/auto-routing/receipts/${id}`);
    if (result.ok) setReceipt(result.body);
    else setFeedback({ error: true, message: 'The exact retained receipt could not be read.' });
  }

  return (
    <section className={styles.autoRouting} aria-labelledby="automatic-routing-title">
      <div className={styles.sectionHead}>
        <h2 id="automatic-routing-title">Automatic routing</h2>
        <span className={board.spacer} />
        <Tooltip label="Re-read the saved rules">
          <ActionIcon
            variant="default"
            aria-label="Refresh automatic routing rules"
            loading={busy}
            onClick={refreshRules}
          >
            <Icon name="i-refresh" />
          </ActionIcon>
        </Tooltip>
      </div>
      <Text size="xs" c="var(--slate)">
        Clients request <code>auto-router</code>, <code>tokenproxy/auto</code> or{' '}
        <code>tokenproxy/auto-router</code>. Tool requests classify as coding; long prompts and
        reasoning cues classify as reasoning; short text without those cues classifies as simple. An
        unconfigured class uses price tiers from the local catalog. A configured target does not
        establish availability, permission, credentials or provider acceptance.
      </Text>
      {resource.error && (
        <Alert color="red" p="xs" title="Automatic rules unavailable">
          {resource.error}
        </Alert>
      )}
      {feedback && (
        <Alert color={feedback.error ? 'orange' : 'teal'} p="xs">
          {feedback.message}
        </Alert>
      )}
      <div className={styles.autoGrid}>
        {CLASSES.map((key) => (
          <Autocomplete
            key={key}
            size="xs"
            label={`${key[0].toUpperCase()}${key.slice(1)} request target`}
            description="Exact provider/model, or blank for local catalog ranking."
            placeholder="Use catalog ranking"
            data={options}
            value={values[key] || ''}
            disabled={!resource.data || review || busy}
            onChange={(value) =>
              setDraft((previous) => ({
                before: previous?.before || resource.data,
                rules: { ...(previous?.rules || resource.data.rules), [key]: value },
              }))
            }
          />
        ))}
      </div>
      {!ok && (
        <Alert color="orange" p="xs">
          Use provider/model targets without whitespace.
        </Alert>
      )}
      {review ? (
        <div className={styles.cascadeReview} role="region" aria-label="Reviewed automatic rules">
          <strong>Review automatic routing changes</strong>
          <span>
            New requests take these targets. In-flight work retains its target. Restore the previous
            values here to reverse future behavior; routing-plan rollback excludes these rules.
          </span>
          <dl>
            {CLASSES.map((key) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  {show(draft.before.rules[key])} → {show(draft.rules[key])}
                </dd>
              </div>
            ))}
          </dl>
          <span className={board.spacer} />
          <Button size="compact-xs" loading={busy} disabled={blocked || !ok} onClick={save}>
            Save automatic rules
          </Button>
          <Button size="compact-xs" variant="default" onClick={() => setReview(false)}>
            Keep editing
          </Button>
        </div>
      ) : null}
      <Group gap="xs">
        {draft && !review && (
          <Button size="xs" disabled={!ok || conflict || busy} onClick={() => setReview(true)}>
            Review automatic rules
          </Button>
        )}
        {draft && (
          <Button size="xs" variant="subtle" disabled={busy} onClick={discard}>
            Discard draft and use the latest read
          </Button>
        )}
        <span className={board.spacer} />
        <Select
          size="xs"
          aria-label="Recent automatic routing change"
          placeholder="Recent change"
          className={board.sort}
          clearable
          data={(resource.data?.receipts || []).map((row) => ({
            value: row.id,
            label: `${row.createdAt} · ${row.id.slice(0, 8)}`,
          }))}
          value={receipt?.id || null}
          onChange={(value) => (value ? inspect(value) : setReceipt(null))}
        />
      </Group>
      {receipt && (
        <div className={styles.notice} role="status">
          <strong>
            {receipt.id.slice(0, 12)} · {receipt.createdAt}
          </strong>
          <span>
            {CLASSES.map(
              (key) => `${key}: ${show(receipt.before[key])} → ${show(receipt.after[key])}`
            ).join(' · ')}
          </span>
        </div>
      )}
      <Text size="xs" c="var(--slate)">
        The most recent 20 receipts are listed. Exact receipt ids remain readable after they leave
        this list.
      </Text>
    </section>
  );
}
