'use client';
import { useState } from 'react';
import { ActionIcon, Alert, Autocomplete, Button, Text, Tooltip } from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import { useResource } from '@/shared/workspace/useResource';
import {
  Board,
  BoardSummary,
  BoardToolbar,
  DensitySwitch,
  useLevel,
} from '@/shared/workspace/Board';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { useConfiguredModels } from '@/shared/workspace/useConfiguredModels';
import board from '@/shared/workspace/board.module.css';
import { policyRequest, shortHash, utcTime } from './policyModel';
import styles from './policy.module.css';

const ENDPOINT = '/api/routing-cascade';

export function CascadePolicy({ density, onDensity }) {
  const advanced = useLevel();
  const resource = useResource(ENDPOINT);
  const [draft, setDraft] = useState(null);
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const pairs = draft?.pairs ?? resource.data?.pairs ?? [];
  const { options } = useConfiguredModels();
  const edit = (value) =>
    setDraft({ pairs: value, revision: draft?.revision ?? resource.data.revision });

  async function refresh() {
    setBusy(true);
    setFailure(null);
    try {
      const state = await policyRequest(ENDPOINT);
      setDraft({ pairs: state.pairs, revision: state.revision });
      setReceipt(state.receipts?.[0] ?? null);
      setUncertain(false);
      setReview(null);
      resource.refresh();
    } catch (error) {
      setFailure(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!review) return;
    setBusy(true);
    setFailure(null);
    setUncertain(true);
    try {
      const result = await policyRequest(ENDPOINT, 'PUT', {
        pairs: review.pairs,
        expectedRevision: review.revision,
      });
      setReceipt(result.receipt);
      setReview(null);
      const current = await policyRequest(ENDPOINT);
      if (current.revision !== result.revision)
        throw new Error(
          'The active cascade differs from the recorded result. Read current policy and receipts before another change.'
        );
      setDraft(null);
      setUncertain(false);
      resource.refresh();
    } catch (error) {
      setReview(null);
      setFailure(
        `${error.message} Read current policy and receipts before another change. This operation is not replayed.`
      );
    } finally {
      setBusy(false);
    }
  }
  const changed = draft && JSON.stringify(draft.pairs) !== JSON.stringify(resource.data?.pairs);
  const locked = busy || uncertain;

  return (
    <Board label="Solo chat cascade" advanced={advanced} density={density}>
      <BoardSummary
        label="Cascade summary"
        chips={[
          { id: null, label: pairs.length === 1 ? 'pair' : 'pairs', count: pairs.length },
          {
            id: 'ignored',
            tone: 'ember',
            label: 'stored entries ignored or merged',
            count: resource.data?.ignoredOrMergedEntries || 0,
          },
        ]}
        note={`Active ${shortHash(resource.data?.revision)} · empty pairs keep cascade off`}
      />
      <BoardToolbar
        actions={
          <>
            <Button
              size="xs"
              variant="default"
              leftSection={<Icon name="i-add" />}
              disabled={!resource.data || locked || pairs.length >= 64}
              onClick={() => edit([...pairs, { strong: '', cheap: '' }])}
            >
              Add pair
            </Button>
            <Button
              size="xs"
              disabled={!changed || locked}
              onClick={() => setReview(structuredClone(draft))}
            >
              Review change
            </Button>
            <Tooltip label="Read current policy and receipts; this replaces local edits">
              <ActionIcon
                variant="default"
                aria-label="Read the current cascade policy"
                loading={busy}
                onClick={refresh}
              >
                <Icon name="i-refresh" />
              </ActionIcon>
            </Tooltip>
          </>
        }
      >
        {onDensity ? <DensitySwitch value={density} onChange={onDensity} /> : null}
      </BoardToolbar>
      {resource.error ? (
        <Text size="xs" c="orange.8" role="alert" className={board.notice}>
          Cascade unavailable. {resource.error}
        </Text>
      ) : null}
      {failure ? (
        <Text size="xs" c="orange.8" role="alert" className={board.notice}>
          {failure}
        </Text>
      ) : null}
      {review ? (
        <div className={styles.cascadeReview} role="region" aria-label="Reviewed cascade mapping">
          <strong>
            {review.pairs.length} pairs replace {resource.data?.pairs?.length ?? 0}
          </strong>
          <span>
            Later solo requests may use another physical model and create additional attempts.
            Account affinity, in-flight requests and routing-plan versions are unchanged. Expected
            revision {shortHash(review.revision)}.
          </span>
          <pre tabIndex={0}>
            {JSON.stringify({ before: resource.data?.pairs, after: review.pairs }, null, 2)}
          </pre>
          <span className={board.spacer} />
          <Button size="compact-xs" loading={busy} disabled={uncertain} onClick={apply}>
            Save cascade mapping
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            disabled={busy}
            onClick={() => setReview(null)}
          >
            Keep editing
          </Button>
        </div>
      ) : null}
      {pairs.map((pair, index) => (
        <div className={styles.cascadeRow} key={index}>
          <Autocomplete
            size="xs"
            aria-label={`Strong model ${index + 1}`}
            placeholder="Requested strong model"
            data={options}
            value={pair.strong}
            disabled={locked}
            onChange={(value) =>
              edit(pairs.map((item, i) => (i === index ? { ...item, strong: value } : item)))
            }
          />
          <Icon name="i-right" />
          <Autocomplete
            size="xs"
            aria-label={`Exploration model ${index + 1}`}
            placeholder="Exploration model"
            data={options}
            value={pair.cheap}
            disabled={locked}
            onChange={(value) =>
              edit(pairs.map((item, i) => (i === index ? { ...item, cheap: value } : item)))
            }
          />
          <InlineConfirm
            label={`Remove pair ${index + 1}`}
            hint="Removes the pair from the local edit. Nothing changes until the mapping is saved."
            verb="Remove"
            icon="i-close"
            tone="red"
            disabled={locked}
            onConfirm={() => edit(pairs.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      {advanced ? (
        <dl className={styles.cascadeFacts}>
          <div>
            <dt>Applies to</dt>
            <dd>
              Solo chat at the original requested model. Plan members, virtual auto routing and
              capability-adapter substitutes bypass cascade planning.
            </dd>
          </div>
          <div>
            <dt>Exploration threshold</dt>
            <dd>
              Serialized request estimate strictly below{' '}
              {resource.data?.limits?.promptEstimateExclusive?.toLocaleString('en') ?? 'Unknown'}{' '}
              tokens, at {resource.data?.limits?.charactersPerEstimatedToken ?? 'Unknown'} UTF-16
              code units per estimated token. No recent tool error and no edit or write call in the
              latest assistant turn.
            </dd>
          </div>
          <div>
            <dt>Escalation</dt>
            <dd>
              HTTP 408, 429 or 5xx from the paired dispatch retries the same body on the strong
              model. Other 4xx responses do not escalate. This can create an additional physical
              attempt.
            </dd>
          </div>
          <div>
            <dt>Strong-model continuity</dt>
            <dd>
              {resource.data?.limits ? resource.data.limits.escalationPinMs / 60000 : 'Unknown'}{' '}
              minutes from escalation, in this process, when a session identity exists. Changing
              pairs does not clear these pins.
            </dd>
          </div>
          <div>
            <dt>Identity and eligibility</dt>
            <dd>
              Pairs match request spelling after colon and slash normalization, before catalog alias
              resolution. Configuration does not verify model support or entitlement.
            </dd>
          </div>
        </dl>
      ) : null}
      {receipt ? (
        <div className={styles.notice} role="status" data-partial={uncertain || undefined}>
          <strong>
            {uncertain ? 'Receipt retained; current state unverified' : 'Read back and verified'}
          </strong>
          <span>
            {receipt.id} · {receipt.outcome} · {utcTime(receipt.recordedAt)}
          </span>
        </div>
      ) : null}
      {resource.data?.ignoredOrMergedEntries > 0 ? (
        <Alert color="orange" p="xs" title="Stored entries need attention">
          {resource.data.ignoredOrMergedEntries} stored entries are ignored or merged by the engine.
          The list shows its effective pairs, and saving replaces that pair list.
        </Alert>
      ) : null}
      <div className={board.messages}>
        {resource.loading && !resource.data ? (
          <div className={board.empty}>Reading cascade policy…</div>
        ) : null}
        {resource.data && !pairs.length ? (
          <div className={board.empty}>
            No configured pairs, so cascade is off. Add a pair to let a strong model use a cheaper
            one for exploration steps.
          </div>
        ) : null}
      </div>
    </Board>
  );
}
