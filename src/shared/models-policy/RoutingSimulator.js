'use client';
import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { policyRequest, scopeModel, shortHash, utcTime } from './policyModel';
import styles from './policy.module.css';

const storageKey = 'tokenproxy.route-simulator.v2';
const capabilities = [
  'vision',
  'pdf',
  'audioInput',
  'videoInput',
  'tools',
  'reasoning',
  'search',
  'embedding',
  'rerank',
  'image',
  'video',
  'tts',
  'stt',
];
const modalities = [
  'chat',
  'embeddings',
  'rerank',
  'image',
  'video',
  'tts',
  'stt',
  'search',
  'ocr',
  'moderation',
  'fetch',
];
export function RoutingSimulator({ draft }) {
  const { scope, accounts, models } = useWorkspace();
  const fromScope = () => ({
    model: scopeModel(scope, models.data?.models),
    modality: 'chat',
    preferredConnectionId: scope.connectionId || undefined,
    requiredCapabilities: [],
    excludedConnectionIds: [],
  });
  const [inspect, setInspect] = useState(false);
  const [input, setInput] = useState(fromScope),
    [capture, setCapture] = useState(null),
    [result, setResult] = useState(null);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(null),
    [validation, setValidation] = useState(null);
  const [includeDraft, setIncludeDraft] = useState(false),
    [sessionHash, setSessionHash] = useState('');
  const [action, setAction] = useState('retain'),
    [minutes, setMinutes] = useState(0),
    [connectionIds, setConnectionIds] = useState([]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (saved?.input && saved?.version === 2) {
          setInput(saved.input);
          setCapture(saved.capture || null);
          setResult(saved.result || null);
          setAction(saved.action || 'retain');
          setMinutes(saved.minutes || 0);
          setConnectionIds(saved.connectionIds || []);
          setIncludeDraft(saved.includeDraft === true);
        }
      } catch {
        /* A damaged local receipt must not prevent a fresh capture. */
      }
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 2,
          input,
          capture,
          result,
          action,
          minutes,
          connectionIds,
          includeDraft,
        })
      );
    } catch {
      /* Storage can be disabled; the current in-memory decision remains usable. */
    }
  }, [loaded, input, capture, result, action, minutes, connectionIds, includeDraft]);
  const options = accounts.map((a) => ({
    value: a.connectionId,
    label: a.displayName || a.connectionId,
  }));
  const names = new Map(options.map((a) => [a.value, a.label]));
  const invalidate = () => {
    setResult(null);
    setValidation(null);
  };
  const update = (patch) => {
    setInput((previous) => ({ ...previous, ...patch }));
    invalidate();
  };
  async function run(operation) {
    setBusy(true);
    setFailure(null);
    invalidate();
    try {
      const packet =
        operation === 'capture'
          ? {
              scope: 'route',
              input,
              ...(sessionHash ? { sessionHash } : {}),
              ...(includeDraft && draft ? { draft } : {}),
            }
          : {
              capture,
              input,
              ...(includeDraft && draft
                ? { draft: { ...draft, expectedCurrent: capture.configuration.currentHash } }
                : {}),
              sessionPolicy: {
                action,
                at: new Date(Date.parse(capture.capturedAt) + minutes * 60000).toISOString(),
                connectionIds,
              },
            };
      const response = await policyRequest(
        `/api/admin/routing-simulator/${operation}`,
        'POST',
        packet
      );
      if (operation === 'capture') {
        setCapture(response.capture);
        setInput(response.input);
      } else if (operation === 'validate') setValidation(response);
      else setResult(response);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.surface}>
      <div className={styles.panelBody}>
        <div className={styles.sectionHead}>
          <h2>Offline route and session preview</h2>
          <Badge variant="light" color="gray">
            No upstream request
          </Badge>
        </div>
        <Text size="sm" c="var(--slate)">
          Compare captured aliases, ordered fallback plans and exact saved drafts. Session changes
          apply at the next request boundary. Captures and results stay on this browser across
          reloads; captures expire after 15 minutes.
        </Text>
        <div className={styles.simulatorInputs}>
          <TextInput
            label="Requested model or plan"
            placeholder="provider/model or plan name"
            value={input.model || ''}
            disabled={busy}
            onChange={(event) => update({ model: event.currentTarget.value })}
          />
          <Select
            label="Automatic routing task class"
            placeholder="Required for auto-router"
            data={['simple', 'coding', 'reasoning']}
            value={input.taskClass || null}
            clearable
            disabled={busy}
            onChange={(value) => update({ taskClass: value || undefined })}
          />
          <Select
            label="Agent role (operator supplied)"
            data={['unknown', 'parent', 'sub']}
            value={input.agentRole || 'unknown'}
            disabled={busy}
            allowDeselect={false}
            onChange={(agentRole) => update({ agentRole })}
          />
          <Select
            label="Solo cascade facts (hypothetical)"
            data={['unknown', 'exploration', 'non-exploration', 'escalated']}
            value={input.cascadeMode || 'unknown'}
            disabled={busy}
            allowDeselect={false}
            onChange={(cascadeMode) => update({ cascadeMode })}
          />
          <Select
            label="Modality"
            data={modalities}
            value={input.modality || 'chat'}
            disabled={busy}
            allowDeselect={false}
            onChange={(modality) => update({ modality })}
          />
          <NumberInput
            label="Context tokens (operator supplied)"
            min={0}
            max={100000000}
            allowDecimal={false}
            value={input.contextTokens ?? ''}
            disabled={busy}
            onChange={(value) => update({ contextTokens: value === '' ? undefined : value })}
          />
          <NumberInput
            label="Output tokens (operator supplied)"
            min={0}
            max={100000000}
            allowDecimal={false}
            value={input.outputTokens ?? ''}
            disabled={busy}
            onChange={(value) => update({ outputTokens: value === '' ? undefined : value })}
          />
          <Select
            label="Preferred account"
            placeholder="Rank all eligible accounts"
            searchable
            clearable
            data={options}
            value={input.preferredConnectionId || null}
            disabled={busy}
            onChange={(value) =>
              update({
                preferredConnectionId: value || undefined,
                ...(value ? {} : { strictPreferredConnection: false }),
              })
            }
          />
          <MultiSelect
            label="Excluded accounts"
            searchable
            data={options}
            value={input.excludedConnectionIds || []}
            disabled={busy}
            onChange={(excludedConnectionIds) => update({ excludedConnectionIds })}
          />
          <MultiSelect
            label="Required capabilities"
            data={capabilities}
            maxValues={12}
            value={input.requiredCapabilities || []}
            disabled={busy}
            onChange={(requiredCapabilities) => update({ requiredCapabilities })}
          />
          <TextInput
            label="Existing session hash (optional)"
            placeholder="32–64 lowercase hexadecimal characters"
            value={sessionHash}
            disabled={busy}
            onChange={(event) => {
              setSessionHash(event.currentTarget.value);
              setCapture(null);
              invalidate();
            }}
            description="Used only for capture; never saved in browser storage."
          />
          <Select
            label="Session policy preview"
            data={[
              { value: 'retain', label: 'Retain existing pins' },
              { value: 'clear', label: 'Clear selected account pins' },
              { value: 'expire', label: 'Expire selected account pins at boundary' },
            ]}
            value={action}
            allowDeselect={false}
            disabled={busy}
            onChange={(value) => {
              setAction(value);
              invalidate();
            }}
          />
          <NumberInput
            label="Next request after capture (minutes)"
            min={0}
            max={43200}
            allowDecimal={false}
            value={minutes}
            disabled={busy}
            onChange={(value) => {
              setMinutes(Number(value) || 0);
              invalidate();
            }}
          />
          <MultiSelect
            label="Session accounts (empty means all captured)"
            searchable
            data={options}
            value={connectionIds}
            disabled={busy || action === 'retain'}
            onChange={(value) => {
              setConnectionIds(value);
              invalidate();
            }}
          />
          <Stack gap="xs" justify="end">
            <Switch
              label="Require the preferred account"
              checked={input.strictPreferredConnection === true}
              disabled={busy || !input.preferredConnectionId}
              onChange={(event) =>
                update({ strictPreferredConnection: event.currentTarget.checked })
              }
            />
            <Switch
              label="Compare exact saved draft"
              checked={includeDraft}
              disabled={busy || !draft}
              onChange={(event) => {
                setIncludeDraft(event.currentTarget.checked);
                setCapture(null);
                invalidate();
              }}
            />
          </Stack>
        </div>
        {includeDraft && !draft && (
          <Alert mt="sm" color="orange">
            The saved draft is unavailable. Select its unchanged revision in Configuration versions,
            or capture without a draft.
          </Alert>
        )}
        <Group mt="md">
          <Button
            variant="default"
            disabled={busy || !scope.model}
            onClick={() => {
              setInput(fromScope());
              setCapture(null);
              invalidate();
            }}
          >
            Use shared model/account scope
          </Button>
          <Button
            disabled={busy || !input.model || (includeDraft && !draft)}
            onClick={() => run('capture')}
          >
            Capture current inputs
          </Button>
          <Button variant="light" disabled={busy || !capture} onClick={() => run('validate')}>
            Validate capture
          </Button>
          <Button
            variant="light"
            disabled={busy || !capture || (includeDraft && !draft)}
            onClick={() => run('simulate')}
          >
            Simulate captured decision
          </Button>
        </Group>
        {busy && (
          <Text role="status" mt="sm">
            Evaluating the captured route boundary…
          </Text>
        )}
        {failure && (
          <Alert color="red" title="Simulation operation refused" mt="md">
            <Text>{failure.message}</Text>
            <Text size="sm" className={styles.mono}>
              {failure.code}
            </Text>
            <Text size="sm">
              Capture again after a model, configuration or draft revision changes, or when the
              capture expires.
            </Text>
          </Alert>
        )}
        {capture && (
          <div className={styles.capture}>
            <span>Captured {utcTime(capture.capturedAt)}</span>
            <span>Expires {utcTime(capture.expiresAt)}</span>
            <span className={styles.mono} title={capture.captureId}>
              {shortHash(capture.captureId)}
            </span>
            <span>Requested {capture.scope.requestedModel}</span>
            <span>Configuration {shortHash(capture.configuration.currentHash)}</span>
            {capture.draft && (
              <span>
                Draft revision {capture.draft.revision} · version {capture.draft.versionId}
              </span>
            )}
          </div>
        )}
        {validation && (
          <Alert color="teal" title="Capture shape and freshness validated" mt="sm">
            Exact capture {shortHash(validation.captureId)} matches the supported policy and current
            configuration.
          </Alert>
        )}
      </div>
      {result && (
        <SelectionDock
          open={inspect}
          title="Simulation evidence"
          subtitle={shortHash(result.receipt.captureId)}
          onClose={() => setInspect(false)}
          height="680px"
          detail={
            <div className={styles.receiptDetails}>
              <pre
                tabIndex={0}
                aria-label="Exact captured simulation receipt"
                style={{ overflow: 'auto', maxHeight: 'calc(100dvh - 240px)' }}
              >
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          }
        >
          <div className={styles.result}>
            <div className={styles.decision}>
              <div>
                <span>Before</span>
                <h3>{result.before.selectedModel || result.before.status}</h3>
                <Text size="sm">
                  {names.get(result.before.connectionId) ||
                    result.before.connectionId ||
                    'No selected account'}
                </Text>
              </div>
              <div>
                <span>After</span>
                <h3>{result.after.selectedModel || result.after.status}</h3>
                <Text size="sm">
                  {names.get(result.after.connectionId) ||
                    result.after.connectionId ||
                    'No selected account'}
                </Text>
              </div>
              <div>
                <span>Served model</span>
                <strong>None · upstream unverified</strong>
              </div>
              <div>
                <span>Affected captured pins</span>
                <strong>
                  {result.sessionPreview.affectedCount} / {result.sessionPreview.sessions.length}
                </strong>
                <Text size="sm">Next request only</Text>
              </div>
            </div>
            <div className={styles.panelBody}>
              <Table.ScrollContainer
                minWidth={760}
                scrollAreaProps={{
                  viewportProps: {
                    tabIndex: 0,
                    role: 'region',
                    'aria-label': 'Scroll captured route order',
                    className: styles.tableViewport,
                  },
                }}
              >
                <Table aria-label="Captured route ordering">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Order</Table.Th>
                      <Table.Th>Requested → resolved</Table.Th>
                      <Table.Th>Local account decision</Table.Th>
                      <Table.Th>Candidate / skip evidence</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {result.after.attempts.map((attempt) => (
                      <Table.Tr key={attempt.order}>
                        <Table.Td>{attempt.order}</Table.Td>
                        <Table.Td>
                          {attempt.requestedModel}
                          <Text size="sm">{attempt.resolvedModel || 'Unresolved'}</Text>
                        </Table.Td>
                        <Table.Td>
                          {names.get(attempt.localSelection.connectionId) ||
                            attempt.localSelection.connectionId ||
                            attempt.localSelection.status}
                          <Text size="sm">{attempt.reason}</Text>
                        </Table.Td>
                        <Table.Td>
                          {attempt.candidates.map((c) => (
                            <Text size="sm" key={c.connectionId}>
                              {c.order}. {names.get(c.connectionId) || c.connectionId} ·{' '}
                              {c.atCapacity ? 'at capacity' : 'eligible'} · {c.quotaEvidence}
                            </Text>
                          ))}
                          {attempt.exclusions.map((e, i) => (
                            <Text size="sm" key={i}>
                              {names.get(e.connectionId) || e.connectionId} · {e.reason}
                            </Text>
                          ))}
                          {attempt.capabilityFit && (
                            <Text size="sm">
                              Context{' '}
                              {attempt.capabilityFit.contextFitsDeclaredWindow === null
                                ? 'unknown'
                                : attempt.capabilityFit.contextFitsDeclaredWindow
                                  ? 'fits'
                                  : 'exceeds declared window'}{' '}
                              · missing / unknown{' '}
                              {attempt.capabilityFit.missingOrUnknown.join(', ') || 'none supplied'}
                              . Declared evidence, not an account gate.
                            </Text>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
              {result.after.plans.map((plan) => (
                <Text key={plan.name} size="sm" mt="sm">
                  {plan.name} · {plan.strategy} · {plan.orderedMembers.join(' → ')}
                  {plan.disabled.length
                    ? ` · ${plan.disabled.length} disabled members skipped`
                    : ''}
                </Text>
              ))}
              <h3>Session and cache consequences</h3>
              <Text size="sm">{result.sessionPreview.attribution}</Text>
              {result.sessionPreview.sessions.length === 0 && (
                <Text size="sm">No stored pins for captured physical models.</Text>
              )}
              {result.sessionPreview.sessions.map((session) => (
                <Text size="sm" key={`${session.sessionId}/${session.route}`} mt="xs">
                  {shortHash(session.sessionId)} · {session.route} · {session.reason}
                  <br />
                  {session.before.connectionId || 'None'} → {session.after.connectionId || 'None'} ·{' '}
                  {session.after.model}
                  <br />
                  {session.cacheContinuity}
                </Text>
              ))}
              <Button variant="light" onClick={() => setInspect(true)}>
                Inspect exact before/after evidence
              </Button>
              <Text size="sm" mt="sm">
                {result.after.fallbackContinuation}
              </Text>
              {result.limitations.map((value) => (
                <Text size="sm" c="var(--slate)" key={value} mt="xs">
                  {value}
                </Text>
              ))}
            </div>
          </div>
        </SelectionDock>
      )}
    </div>
  );
}
