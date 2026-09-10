'use client';
import { useState } from 'react';
import { Button, Group, NativeSelect, Stack, Table, Text } from '@mantine/core';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';
import { getHotReloadConfig } from '@/shared/constants/config';

export function accountOperations(connection) {
  return [
    {
      id: 'models',
      label: 'Read model catalog',
      suffix: '/models',
      method: 'GET',
      effect:
        'May contact this account’s provider and refresh its credential. Catalog presence does not establish model entitlement or successful generation.',
    },
    {
      id: 'reconcile',
      label: 'Compare model catalog',
      suffix: '/models/reconcile',
      effect:
        'Reads the upstream catalog and compares the local registry. Optional generation probes can be billable and may use another account for the same provider. The report does not change the registry.',
    },
    {
      id: 'test',
      label: 'Test all configured models',
      suffix: '/test-models',
      effect:
        'Sends generation or modality-specific requests for all configured models. These requests can be billable and may use another account for the same provider. A successful result is not proof for this exact account.',
    },
    ...(getHotReloadConfig(connection.provider, connection.authType)?.models?.length
      ? [
          {
            id: 'reload',
            label: 'Request provider quota refresh',
            suffix: '/hotreload',
            effect:
              'Refreshes credentials and sends small upstream requests that consume quota. The outcome is confirmed only when the reported remaining quota changes.',
          },
        ]
      : []),
    ...(connection.provider === 'github'
      ? [
          {
            id: 'identity',
            label: 'Refresh GitHub account name',
            suffix: '/sync-username',
            effect:
              'Contacts GitHub and replaces this account’s display name with its current login.',
          },
        ]
      : []),
    {
      id: 'rotation',
      label: 'Read token refresh evidence',
      path: '/api/usage/token-refresh',
      method: 'GET',
      effect:
        'Reads stored expiry and last-refresh timestamps. This does not contact a provider or force a token refresh.',
    },
    ...(connection.provider === 'codex'
      ? [
          {
            id: 'export',
            label: 'Download Codex credential file',
            path: '/api/oauth/codex/export',
            effect:
              'Downloads this account’s access and refresh credentials. Requires a signed-in session on the gateway machine or its CLI credential. Keep the downloaded file private.',
          },
        ]
      : []),
  ];
}

export function accountOperationRows(kind, body, id) {
  if (kind === 'rotation')
    return (body?.connections || [])
      .filter((row) => row.id === id)
      .map((row) => ({
        model: 'Token rotation',
        result: row.status,
        detail: `Last refreshed ${row.lastRefreshAt || 'not recorded'}; expires ${row.expiresAt || 'not recorded'}; lead ${row.refreshLeadMs} ms`,
      }));
  if (kind === 'reload')
    return Object.entries(body?.remainingByModel || {}).map(([model, remaining]) => ({
      model,
      result: body.quotaMoved ? 'Quota changed' : 'No confirmed quota change',
      detail: `${remaining} remaining`,
    }));
  return (body?.models || body?.results || []).map((row) => ({
    model: typeof row === 'string' ? row : row.id || row.modelId || row.name,
    result:
      row.classification ||
      (kind === 'models'
        ? 'Catalog entry'
        : row.ok === true
          ? 'Request passed'
          : row.ok === false
            ? 'Request failed'
            : 'Unknown'),
    detail: row.reason || (row.status ? `HTTP ${row.status}` : ''),
  }));
}

export default function AccountOperations({ connection, onSaved }) {
  const [kind, setKind] = useState('models'),
    [probe, setProbe] = useState('none');
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(null),
    [rows, setRows] = useState([]),
    [submitted, setSubmitted] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const actions = accountOperations(connection),
    action = actions.find((item) => item.id === kind) || actions[0];
  const close = () => {
    if (!busy) {
      setNotice(null);
      setRows([]);
      setSubmitted(false);
    }
  };
  async function run() {
    setBusy(true);
    setNotice(null);
    setRows([]);
    const path =
      action.path ||
      `/api/providers/${encodeURIComponent(connection.id)}${action.suffix}${kind === 'reconcile' ? `?probe=${probe}` : ''}`;
    const response = await call(path, {
      method: action.method || 'POST',
      ...(action.method === 'GET'
        ? {}
        : { body: kind === 'export' ? { connectionId: connection.id } : {} }),
    });
    if (!response.ok || response.body?.ok === false) {
      setBusy(false);
      setNotice({
        tone: 'bad',
        title: `The operation was refused (HTTP ${response.status}).`,
        next: 'No successful provider outcome was established. Check account readiness and session permission.',
      });
      return;
    }
    if (kind === 'export') {
      const objectUrl = URL.createObjectURL(
        new Blob([JSON.stringify(response.body, null, 2)], { type: 'application/json' })
      );
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'codex-account.json';
      link.click();
      URL.revokeObjectURL(objectUrl);
      setNotice({
        tone: 'info',
        title: 'The private credential download was requested.',
        next: 'The browser controls file delivery. No credential is displayed here.',
      });
    } else if (kind === 'identity') {
      const read = await call(`/api/providers/${encodeURIComponent(connection.id)}`);
      const verified =
        read.ok &&
        read.body?.connection?.id === connection.id &&
        read.body.connection.name === response.body?.username;
      setNotice({
        tone: verified ? 'ok' : 'warn',
        title: verified
          ? 'GitHub account name saved and read back.'
          : 'The account name write was accepted, but readback was not confirmed.',
      });
      onSaved?.();
    } else {
      const resultRows = accountOperationRows(kind, response.body, connection.id);
      setRows(resultRows);
      const partial =
        response.body?.aborted ||
        response.body?.liveListUsable === false ||
        response.body?.liveListError ||
        (kind === 'reload' && response.body.quotaMoved !== true) ||
        !resultRows.length ||
        resultRows.some((row) => row.result === 'Request failed');
      setNotice({
        tone: partial ? 'warn' : 'info',
        title: partial
          ? 'The operation returned incomplete or unsuccessful evidence.'
          : 'The operation returned evidence.',
        next:
          kind === 'reconcile'
            ? `Applied changes: none. Generation probes: ${response.body.probed ?? 'not reported'}. New upstream IDs: ${(response.body.newUpstream || []).join(', ') || 'none reported'}.`
            : action.effect,
      });
    }
    setBusy(false);
    setSubmitted(true);
    setReviewing(false);
  }
  // Every operation here can contact a provider or be billable, so it confirms
  // where it stands: a Confirm/Cancel pair on the same row, never a dialog.
  return (
    <section className="connections-panel" aria-label="Account diagnostics and export">
      <h2>Account diagnostics and export</h2>
      <Stack gap="xs">
        <NativeSelect
          size="xs"
          label="Operation"
          value={action.id}
          disabled={busy || submitted}
          data={actions.map((item) => ({ value: item.id, label: item.label }))}
          onChange={(event) => {
            setKind(event.currentTarget.value);
            setNotice(null);
            setRows([]);
            setReviewing(false);
          }}
        />
        <Text size="xs" c="dimmed">
          {action.effect}
        </Text>
        {kind === 'reconcile' ? (
          <NativeSelect
            size="xs"
            label="Generation probes"
            value={probe}
            disabled={busy || submitted}
            onChange={(event) => setProbe(event.currentTarget.value)}
            data={[
              { value: 'none', label: 'None; catalog comparison only' },
              { value: 'missing', label: 'Only missing models; can be billable' },
              { value: 'all', label: 'All models; can be billable' },
            ]}
          />
        ) : null}
        {notice ? <Notice {...notice} /> : null}
        {rows.length ? (
          <Table.ScrollContainer minWidth={420}>
            <Table fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Subject</Table.Th>
                  <Table.Th>Outcome</Table.Th>
                  <Table.Th>Evidence</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row, index) => (
                  <Table.Tr key={`${row.model}-${index}`}>
                    <Table.Td>{row.model}</Table.Td>
                    <Table.Td>{row.result}</Table.Td>
                    <Table.Td>{row.detail}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : null}
        <Group justify="flex-start" gap="xs">
          {submitted ? (
            <Button size="xs" variant="default" onClick={close} disabled={busy}>
              Choose another operation
            </Button>
          ) : reviewing ? (
            <>
              <Button
                size="xs"
                loading={busy}
                onClick={run}
                aria-label={`Confirm ${action.label.toLowerCase()}`}
              >
                Confirm
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={busy}
                onClick={() => setReviewing(false)}
              >
                Cancel
              </Button>
              <Text size="xs" c="dimmed">
                Recorded observations and any upstream usage remain. A downloaded file stays private
                to your browser.
              </Text>
            </>
          ) : (
            <Button size="xs" loading={busy} onClick={() => setReviewing(true)}>
              {action.label}
            </Button>
          )}
        </Group>
      </Stack>
    </section>
  );
}
