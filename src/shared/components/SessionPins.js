'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Table, UnstyledButton } from '@mantine/core';
import { tableFeatures, useTable } from '@tanstack/react-table';
import { call } from '@/shared/api';
import { useOptionalWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { quotaTimestamp } from '@/shared/workspace/quotaWorkbenchModel';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import styles from './sessionPins.module.css';

const ROOT = '/api/admin/session-pins';
const FEATURES = tableFeatures({});
const timestamp = (value) => (value ? `${quotaTimestamp(value)} UTC` : 'Unknown');

// Shared workspace scope maps onto the exact list filters the backend accepts.
// The shared end boundary is exclusive; lastSeenTo is inclusive at the same instant.
export function pinsUrl(scope, cursor = '') {
  const query = new URLSearchParams();
  if (scope?.provider) query.set('provider', scope.provider);
  if (scope?.connectionId) query.set('connectionId', scope.connectionId);
  if (scope?.model) query.set('model', scope.model);
  if (scope?.start) query.set('lastSeenFrom', scope.start);
  if (scope?.end) query.set('lastSeenTo', scope.end);
  if (cursor) query.set('before', cursor);
  const text = query.toString();
  return text ? `${ROOT}?${text}` : ROOT;
}

// Every stored status renders as its own word. Anything unrecognized is uncertain,
// never silently folded into a healthy state.
export function receiptState(action) {
  switch (action?.status) {
    case 'preview':
      return 'Saved preview';
    case 'queued':
      return 'Queued';
    case 'applied':
      return 'Applied';
    case 'cancelled':
      return 'Cancelled';
    case 'conflict':
      return action.reason === 'preview_expired' ? 'Stale preview' : 'Conflicting state';
    default:
      return 'Uncertain';
  }
}

function History({ pin, bound, busy, onReceipt }) {
  return (
    <>
      <h4>Recent history</h4>
      <p className={styles.note}>
        Most recent {bound} requests, account switches and control receipts for this binding. Older
        history is retained by the gateway but not shown here.
      </p>
      {pin.requests.length ? (
        <ul className={styles.history} aria-label="Recent requests">
          {pin.requests.map((request) => (
            <li key={request.id}>
              Requested {request.requestedModel || 'Unknown'} · served{' '}
              {request.servedModel || 'Not confirmed'} · {request.status} ·{' '}
              <code>{request.id}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>
          No exact retained requests for this binding identity and model.
        </p>
      )}
      {pin.switches.length > 0 && (
        <ul className={styles.history} aria-label="Recent account switches">
          {pin.switches.map((item) => (
            <li key={item.id}>
              {timestamp(item.switchedAt)} · {item.fromConnectionId || 'First binding'} →{' '}
              {item.toConnectionId} · {item.trigger}
            </li>
          ))}
        </ul>
      )}
      {pin.actions.length > 0 && (
        <ul className={styles.history} aria-label="Recent control receipts">
          {pin.actions.map((item) => (
            <li key={item.id}>
              <button type="button" disabled={busy} onClick={() => onReceipt(item.id)}>
                Receipt <code>{item.id.slice(0, 8)}</code> · {item.action} · {receiptState(item)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Inspector({
  pin,
  busy,
  form,
  preview,
  receipt,
  bound,
  onSubmit,
  onApply,
  onReceipt,
  onEdit,
}) {
  const { action, target, deadline, setAction, setTarget, setDeadline } = form;
  return (
    <div className={styles.dockBody}>
      <dl className={styles.facts}>
        <dt>Binding state</dt>
        <dd>{pin.state === 'active' ? 'Active' : 'Expired'}</dd>
        <dt>Provider</dt>
        <dd>{pin.provider || 'Unknown'}</dd>
        <dt>Pinned (UTC)</dt>
        <dd>{timestamp(pin.pinnedAt)}</dd>
        <dt>Last seen (UTC)</dt>
        <dd>{timestamp(pin.lastSeenAt)}</dd>
        <dt>Idle expiry (UTC)</dt>
        <dd>{timestamp(pin.expiresAt)}</dd>
        <dt>Operator deadline (UTC)</dt>
        <dd>{pin.operatorExpiresAt ? timestamp(pin.operatorExpiresAt) : 'No operator deadline'}</dd>
        <dt>Session join</dt>
        <dd>
          {pin.session
            ? `${pin.session.id} · ${pin.session.identitySource} routing identity`
            : 'No exact retained session join'}
        </dd>
      </dl>
      <p className={styles.note}>
        Normal activity extends idle expiry by 24 hours, capped by an operator deadline. Controls
        apply to later requests only; admitted work stays on its current account.
      </p>
      <History pin={pin} bound={bound} busy={busy} onReceipt={onReceipt} />
      <h4>Change this binding</h4>
      <form onSubmit={onSubmit} className={styles.form}>
        <label className={styles.field}>
          <span>Change</span>
          <select
            disabled={busy}
            value={action}
            onChange={(e) => onEdit(() => setAction(e.target.value))}
          >
            <option value="clear">Clear affinity</option>
            <option value="expire">Set expiry deadline</option>
            <option value="reassign">Reassign on a later request</option>
          </select>
        </label>
        {action === 'reassign' && (
          <label className={styles.field}>
            <span>Target account</span>
            <select
              required
              value={target}
              disabled={busy}
              onChange={(e) => onEdit(() => setTarget(e.target.value))}
            >
              <option value="">Choose an account</option>
              {pin.targets
                .filter((item) => item.id !== pin.connectionId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || item.id} · {item.enabled ? 'Enabled' : 'Disabled'}
                  </option>
                ))}
            </select>
          </label>
        )}
        {action === 'expire' && (
          <label className={styles.field}>
            <span>Expiry in your local time</span>
            <input
              required
              type="datetime-local"
              value={deadline}
              disabled={busy}
              onChange={(e) => onEdit(() => setDeadline(e.target.value))}
            />
          </label>
        )}
        <Button type="submit" disabled={busy}>
          Preview change
        </Button>
      </form>
      {preview && (
        <div role="region" aria-label="Pin change preview" className={styles.preview}>
          <strong>Preview before applying</strong>
          <p>{preview.preview.consequence}</p>
          <p>
            One pin affected. Model remains {preview.model}. Upstream readiness remains unknown.
          </p>
          {preview.preview.localTarget && (
            <p>
              Captured account decision {preview.preview.localTarget.status} ·{' '}
              {preview.preview.localTarget.reason}
            </p>
          )}
          {preview.preview.conflicts?.length > 0 && (
            <ul>
              {preview.preview.conflicts.map((item, index) => (
                <li key={index}>{item.reason}</li>
              ))}
            </ul>
          )}
          {preview.preview.cancelledActions?.length > 0 && (
            <p>
              Clearing also cancels queued control {preview.preview.cancelledActions.join(', ')}.
            </p>
          )}
          {preview.preview.unknownEvidence?.length > 0 && (
            <p className={styles.note}>
              Not verified here · {preview.preview.unknownEvidence.join(', ')}
            </p>
          )}
          <p className={styles.note}>
            Preview valid until {timestamp(preview.previewExpiresAt)}. Pending reassignment waits if
            its account is unavailable or a request explicitly names a different account. Clear
            affinity cancels a pending reassignment.
          </p>
          <Button disabled={busy} onClick={onApply}>
            Apply this change
          </Button>
        </div>
      )}
      {receipt && (
        <div role="status" className={styles.receipt}>
          <strong>{receiptState(receipt)}</strong>
          <p>
            Control receipt <code>{receipt.id}</code> · {receipt.reason || 'no reason recorded'}
          </p>
          <p>
            {receipt.status === 'queued'
              ? 'Waiting for a subsequent request. No request has been moved.'
              : 'This receipt describes affinity control, not provider acceptance or a billing result.'}
          </p>
          <Button
            variant="subtle"
            size="compact-sm"
            disabled={busy}
            onClick={() => onReceipt(receipt.id)}
          >
            Refresh receipt
          </Button>
        </div>
      )}
    </div>
  );
}

export default function SessionPins({ onChanged } = {}) {
  const workspace = useOptionalWorkspace();
  const scope = workspace?.scope;
  const scopeKey = pinsUrl(scope);
  // A cursor pages within one filtered set; a filter change restarts paging
  // by keying the paging state to the filter set, never by an effect.
  const [paging, setPaging] = useState({ key: scopeKey, cursor: '', trail: [] });
  const cursor = paging.key === scopeKey ? paging.cursor : '';
  const trail = paging.key === scopeKey ? paging.trail : [];
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState({ key: null, body: null, error: '' });
  const [selectedId, setSelectedId] = useState(null);
  const [action, setAction] = useState('clear');
  const [target, setTarget] = useState('');
  const [deadline, setDeadline] = useState('');
  const [preview, setPreview] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [mutationError, setMutationError] = useState('');
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const url = pinsUrl(scope, cursor);
  const readKey = `${url}#${revision}`;
  useEffect(() => {
    let active = true;
    void call(url).then((response) => {
      if (!active) return;
      setRead({
        key: readKey,
        body: response.ok ? response.body : null,
        error: response.ok ? '' : response.body?.code || 'Pins could not be read',
      });
    });
    return () => {
      active = false;
    };
  }, [url, readKey]);
  const page = read.key === readKey ? read.body : null;
  const error = mutationError || (read.key === readKey ? read.error : '');
  const busy = pending || read.key !== readKey;
  const refresh = () => {
    setPreview(null);
    setMutationError('');
    setRevision((value) => value + 1);
  };
  const edit = (update) => {
    setPreview(null);
    setMutationError('');
    update();
  };
  const select = useCallback((id) => {
    setSelectedId(id);
    setPreview(null);
    setReceipt(null);
    setMutationError('');
    setTarget('');
  }, []);
  const pins = page?.pins || [];
  const selected = pins.find((pin) => pin.id === selectedId) || null;
  const bound = page?.boundaries?.historyLimitPerPin ?? 8;
  async function inspect(event) {
    event.preventDefault();
    if (!selected) return;
    if (action === 'expire' && !Number.isFinite(Date.parse(deadline))) {
      setMutationError('Choose a valid expiry');
      return;
    }
    const seq = ++generation.current;
    setPending(true);
    setMutationError('');
    setPreview(null);
    const response = await call(`${ROOT}/preview`, {
      method: 'POST',
      body: {
        id: crypto.randomUUID(),
        pinId: selected.id,
        expectedRevision: selected.revision,
        action,
        ...(action === 'reassign' ? { targetConnectionId: target } : {}),
        ...(action === 'expire' ? { deadline: new Date(deadline).toISOString() } : {}),
      },
    });
    if (seq !== generation.current) return;
    if (response.ok) setPreview(response.body);
    else setMutationError(response.body?.code || 'Preview was refused');
    setPending(false);
  }
  async function apply() {
    if (!preview) return;
    const seq = ++generation.current;
    setPending(true);
    setMutationError('');
    const response = await call(`${ROOT}/apply`, {
      method: 'POST',
      body: { id: preview.id, expectedRevision: preview.expectedRevision },
    });
    if (seq !== generation.current) return;
    setPreview(null);
    if (response.body?.id) setReceipt(response.body);
    if (!response.ok)
      setMutationError(response.body?.reason || response.body?.code || 'Change was refused');
    else {
      onChanged?.(response.body);
      setRevision((value) => value + 1);
    }
    setPending(false);
  }
  async function readReceipt(id) {
    const seq = ++generation.current;
    setPending(true);
    const response = await call(`${ROOT}/actions/${id}`);
    if (seq !== generation.current) return;
    if (response.ok) setReceipt(response.body);
    else setMutationError(response.body?.code || 'Receipt could not be read');
    setPending(false);
  }
  const columns = useMemo(
    () => [
      {
        accessorKey: 'model',
        header: 'Model',
        cell: ({ row }) => (
          <UnstyledButton
            aria-label={`Inspect pin ${row.original.model} on ${row.original.connectionId}`}
            aria-pressed={row.original.id === selectedId}
            onClick={() => select(row.original.id)}
          >
            {row.original.model}
          </UnstyledButton>
        ),
      },
      { accessorKey: 'connectionId', header: 'Account' },
      {
        accessorKey: 'provider',
        header: 'Provider',
        cell: ({ row }) => row.original.provider || 'Unknown',
      },
      {
        accessorKey: 'state',
        header: 'Binding',
        cell: ({ row }) => (row.original.state === 'active' ? 'Active' : 'Expired'),
      },
      {
        accessorKey: 'lastSeenAt',
        header: 'Last seen (UTC)',
        cell: ({ row }) => timestamp(row.original.lastSeenAt),
      },
      {
        accessorKey: 'expiresAt',
        header: 'Expires (UTC)',
        cell: ({ row }) => timestamp(row.original.expiresAt),
      },
      {
        accessorKey: 'operatorExpiresAt',
        header: 'Operator deadline (UTC)',
        cell: ({ row }) =>
          row.original.operatorExpiresAt
            ? timestamp(row.original.operatorExpiresAt)
            : 'No operator deadline',
      },
    ],
    [selectedId, select]
  );
  // The server owns order: stable primary-key pagination. Client sorting would
  // let a live update move the selected row under the operator.
  const table = useTable({ features: FEATURES, columns, data: pins, getRowId: (row) => row.id });
  return (
    <section className={styles.workbench} aria-labelledby="session-pins-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <div>
          <h3 id="session-pins-title">Account pins</h3>
          <p className={styles.note}>
            A pin keeps one routing identity and physical model on an account. Controls apply to
            later requests; admitted work stays on its current account. Opaque pin identifiers are
            linkable routing hashes, not raw client identities.
          </p>
        </div>
        <Button
          variant="subtle"
          size="compact-sm"
          disabled={busy}
          onClick={() => {
            setPaging({ key: scopeKey, cursor: '', trail: [] });
            refresh();
          }}
        >
          Refresh pins
        </Button>
      </div>
      {(scope?.provider || scope?.connectionId || scope?.model || scope?.start) && (
        <p className={styles.notice}>
          The shared scope filters this list. The time range bounds each pin&apos;s recorded last
          activity, not its expiry.
        </p>
      )}
      {error && (
        <p role="alert" className={styles.alert}>
          {error.replaceAll('_', ' ')}. Refresh and preview again before applying.
        </p>
      )}
      {page ? (
        <p className={styles.note}>Observed {timestamp(page.observedAt)}.</p>
      ) : (
        <p role="status">Reading pins…</p>
      )}
      {page && pins.length === 0 && (
        <p className={styles.empty}>No retained pins match this scope and page.</p>
      )}
      <SelectionDock
        open={Boolean(selectedId)}
        title={selected ? selected.model : 'Selected pin'}
        subtitle={selected ? `Account ${selected.connectionId}` : null}
        onClose={() => select(null)}
        detail={
          selected ? (
            <Inspector
              pin={selected}
              busy={busy}
              bound={bound}
              form={{ action, target, deadline, setAction, setTarget, setDeadline }}
              preview={preview}
              receipt={receipt}
              onSubmit={inspect}
              onApply={apply}
              onReceipt={readReceipt}
              onEdit={edit}
            />
          ) : selectedId && page ? (
            <p className={styles.notice} role="status">
              The selected pin is not in the current page or scope. Its selection is retained; widen
              the scope or page back to it.
            </p>
          ) : null
        }
      >
        <Table.ScrollContainer minWidth={780} type="native">
          <Table
            stickyHeader
            highlightOnHover
            className={styles.table}
            aria-label="Retained account pins"
          >
            <Table.Thead>
              {table.getHeaderGroups().map((group) => (
                <Table.Tr key={group.id}>
                  {group.headers.map((header) => (
                    <Table.Th key={header.id}>
                      <table.FlexRender header={header} />
                    </Table.Th>
                  ))}
                </Table.Tr>
              ))}
            </Table.Thead>
            <Table.Tbody>
              {table.getRowModel().rows.map((row) => (
                <Table.Tr key={row.id} data-selected={row.id === selectedId || undefined}>
                  {row.getAllCells().map((cell) => (
                    <Table.Td key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <div className={styles.pager}>
          {trail.length > 0 && (
            <Button
              variant="default"
              size="compact-sm"
              disabled={busy}
              onClick={() =>
                setPaging({ key: scopeKey, cursor: trail.at(-1), trail: trail.slice(0, -1) })
              }
            >
              Previous pins
            </Button>
          )}
          {page?.next && (
            <Button
              variant="default"
              size="compact-sm"
              disabled={busy}
              onClick={() =>
                setPaging({ key: scopeKey, cursor: page.next, trail: [...trail, cursor] })
              }
            >
              More pins
            </Button>
          )}
        </div>
      </SelectionDock>
    </section>
  );
}
