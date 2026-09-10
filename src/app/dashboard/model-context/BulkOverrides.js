'use client';
import { useState } from 'react';
import { Alert, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { call } from '@/shared/api';
import { bulkReadbackMatches, parseBulkOverrides, reviewBulkOverrides } from './bulkModel';
const show = (value) =>
  value === null ? 'No saved key' : `${value.toLocaleString('en-US')} tokens`;

// The bulk editor is an inline section of the board, not a layer. Its own
// review step stays, because a batch write over exact keys is the one place a
// commit-on-blur field cannot show what it is about to replace.
export function BulkOverrides({ overrides, disabled, onReadback }) {
  const [setText, setSetText] = useState('');
  const [removeText, setRemoveText] = useState('');
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState(null);
  function prepare() {
    try {
      setReview(reviewBulkOverrides(parseBulkOverrides(setText, removeText), overrides));
      setNotice(null);
    } catch (error) {
      setNotice({ error: true, text: error.message });
    }
  }
  async function save() {
    if (!review || busy || uncertain) return;
    setBusy(true);
    setNotice(null);
    const result = await call('/api/model-context', { method: 'POST', body: review });
    if (!result.ok || result.body?.success !== true) {
      setNotice({
        error: true,
        text:
          result.status === 409
            ? 'A reviewed key changed. Refresh configuration and review this retained draft again.'
            : 'The bulk change was not confirmed. Read current settings before another change.',
      });
      setUncertain(result.status === 0 || result.status >= 500);
      setBusy(false);
      return;
    }
    const read = await call('/api/model-context');
    if (read.ok) onReadback(read.body);
    const confirmed =
      result.status !== 207 &&
      result.body.persistence === 'confirmed' &&
      read.ok &&
      bulkReadbackMatches(review, read.body?.overrides);
    setNotice({
      error: !confirmed,
      text: confirmed
        ? `${review.set.length} set and ${review.deleteKeys.length} remove operations saved and verified. Unrelated keys were preserved.`
        : 'The change was accepted, but persisted readback is incomplete. Inspect current settings before another change.',
    });
    if (confirmed) {
      setReview(null);
      setSetText('');
      setRemoveText('');
    } else setUncertain(true);
    setBusy(false);
  }
  return (
    <section aria-label="Edit several context-window overrides">
      <Stack gap="xs">
        <h2>Edit several overrides</h2>
        <Text size="xs" c="dimmed">
          Exact keys retain their matching order. Provider-scoped, bare and wildcard keys can affect
          different populations. This changes configured limits for later requests, not provider
          entitlement or client compaction policy.
        </Text>
        {notice && (
          <Alert color={notice.error ? 'orange' : 'teal'} p="xs">
            {notice.text}
          </Alert>
        )}
        <Textarea
          size="xs"
          label="Overrides to set"
          description="One exact key = token limit per line."
          minRows={3}
          value={setText}
          disabled={disabled || busy || uncertain}
          onChange={(event) => {
            setSetText(event.currentTarget.value);
            setReview(null);
          }}
          placeholder={'openai/example-model = 128000\nexample-* = 64000'}
        />
        <Textarea
          size="xs"
          label="Override keys to remove"
          description="One exact saved key per line. Removing exposes the next matching rule or default."
          minRows={2}
          value={removeText}
          disabled={disabled || busy || uncertain}
          onChange={(event) => {
            setRemoveText(event.currentTarget.value);
            setReview(null);
          }}
        />
        {review ? (
          <>
            <h3>Review exact key changes</h3>
            <div
              className="model-context-bulk-review"
              role="region"
              aria-label="Reviewed context override changes"
              tabIndex={0}
            >
              <dl>
                {review.set.map((item) => (
                  <div key={item.key}>
                    <dt>
                      <code>{item.key}</code>
                    </dt>
                    <dd>
                      {show(review.expectedOverrides[item.key])} → {show(item.contextWindow)}
                    </dd>
                  </div>
                ))}
                {review.deleteKeys.map((key) => (
                  <div key={key}>
                    <dt>
                      <code>{key}</code>
                    </dt>
                    <dd>{show(review.expectedOverrides[key])} → Remove saved key</dd>
                  </div>
                ))}
              </dl>
            </div>
            <Text size="xs" c="dimmed">
              Only these keys are checked and changed together. Concurrent changes to a reviewed key
              are refused; concurrent sibling keys remain. Restore these previous values to reverse
              future behavior. The readback is not a retained change-history service.
            </Text>
            <Group gap="xs">
              <Button size="xs" loading={busy} disabled={disabled || uncertain} onClick={save}>
                Save reviewed overrides
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={busy}
                onClick={() => {
                  setReview(null);
                  setUncertain(false);
                }}
              >
                Return to retained draft
              </Button>
            </Group>
          </>
        ) : (
          <Group gap="xs">
            <Button size="xs" disabled={disabled || busy || uncertain} onClick={prepare}>
              Review exact keys
            </Button>
          </Group>
        )}
      </Stack>
    </section>
  );
}
