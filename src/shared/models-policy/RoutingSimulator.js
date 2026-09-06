'use client';
import { useState } from 'react';
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
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { policyRequest, scopeModel, shortHash, utcTime } from './policyModel';
import styles from './policy.module.css';

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
const fit = (value) =>
  value === true
    ? 'Fits declared limit'
    : value === false
      ? 'Exceeds declared limit'
      : 'Unknown / not supplied';
export function RoutingSimulator({ draft }) {
  const { scope, accounts, models } = useWorkspace();
  const fromScope = () => ({
    model: scopeModel(scope, models.data?.models),
    modality: 'chat',
    preferredConnectionId: scope.connectionId || undefined,
    requiredCapabilities: [],
    excludedConnectionIds: [],
  });
  const [input, setInput] = useState(fromScope),
    [capture, setCapture] = useState(null),
    [result, setResult] = useState(null),
    [validation, setValidation] = useState(null);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(null),
    [includeDraft, setIncludeDraft] = useState(false);
  const accountOptions = accounts.map((account) => ({
    value: account.connectionId,
    label: account.displayName || account.connectionId,
  }));
  const names = new Map(
    accounts.map((account) => [account.connectionId, account.displayName || account.connectionId])
  );
  const update = (patch) => {
    setInput((previous) => ({ ...previous, ...patch }));
    setResult(null);
    setValidation(null);
  };
  async function run(operation) {
    setBusy(true);
    setFailure(null);
    setResult(null);
    setValidation(null);
    try {
      const response = await policyRequest(
        `/api/admin/routing-simulator/${operation}`,
        'POST',
        operation === 'capture'
          ? { input }
          : {
              capture,
              input,
              ...(includeDraft && draft
                ? { draft: { ...draft, expectedCurrent: capture.configuration.currentHash } }
                : {}),
            }
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
          <h2>Offline account decision</h2>
          <Badge variant="light" color="gray">
            No upstream request
          </Badge>
        </div>
        <Text size="sm" c="#5b6980">
          Capture the local inputs for one physical model, then replay them unchanged. The history
          range does not reconstruct an earlier state. No session identifier is supplied here, so
          affinity is explicitly assumed new.
        </Text>
        <div className={styles.simulatorInputs}>
          <TextInput
            label="Requested physical model"
            placeholder="provider/model"
            value={input.model || ''}
            disabled={busy}
            onChange={(event) => update({ model: event.currentTarget.value })}
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
            data={accountOptions}
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
            data={accountOptions}
            value={input.excludedConnectionIds || []}
            disabled={busy}
            onChange={(excludedConnectionIds) => update({ excludedConnectionIds })}
          />
          <MultiSelect
            label="Required capabilities"
            data={capabilities}
            value={input.requiredCapabilities || []}
            disabled={busy}
            onChange={(requiredCapabilities) => update({ requiredCapabilities })}
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
              label="Include stored draft declaration"
              checked={includeDraft}
              disabled={busy || !draft}
              onChange={(event) => {
                setIncludeDraft(event.currentTarget.checked);
                setResult(null);
                setValidation(null);
              }}
            />
          </Stack>
        </div>
        <Group mt="md">
          <Button
            variant="default"
            disabled={busy || !scope.model}
            onClick={() => {
              setInput(fromScope());
              setResult(null);
              setValidation(null);
            }}
          >
            Use shared model/account scope
          </Button>
          <Button disabled={busy || !input.model} onClick={() => run('capture')}>
            Capture current inputs
          </Button>
          <Button variant="light" disabled={busy || !capture} onClick={() => run('validate')}>
            Validate capture
          </Button>
          <Button variant="light" disabled={busy || !capture} onClick={() => run('simulate')}>
            Simulate captured decision
          </Button>
        </Group>
        {busy && (
          <Text role="status" mt="sm">
            Reading the local simulation boundary…
          </Text>
        )}
        {failure && (
          <Alert color="red" title="Simulation operation refused" mt="md">
            {failure.message}
            <Text size="sm" className={styles.mono}>
              {failure.code}
            </Text>
            <Text size="sm">
              The previous capture is retained. A different physical model requires a fresh capture.
            </Text>
          </Alert>
        )}
        {capture && (
          <div className={styles.capture}>
            <span>Captured {utcTime(capture.capturedAt)}</span>
            <span className={styles.mono} title={capture.captureId}>
              {shortHash(capture.captureId)}
            </span>
            <span>Requested {capture.scope.requestedModel}</span>
            <span>
              Resolved {capture.scope.provider}/{capture.scope.model}
            </span>
            <Text size="sm">
              Repository and process reads are not atomic. The content hash is not a signature or
              proof of origin.
            </Text>
          </div>
        )}
        {validation && (
          <Alert
            color={validation.draftPreview?.valid === false ? 'orange' : 'teal'}
            title="Capture shape validated"
            mt="sm"
          >
            Exact capture {shortHash(validation.captureId)} matches the supported policy version.
            {validation.draftPreview && (
              <Text size="sm">
                Draft declarations{' '}
                {validation.draftPreview.valid ? 'are locally valid' : 'need correction'}. They are
                not applied to account ranking.
              </Text>
            )}
          </Alert>
        )}
      </div>
      {result && (
        <div className={styles.result}>
          <div className={styles.decision}>
            <div>
              <span>Local decision</span>
              <h3>
                {result.localSelection.status === 'candidate'
                  ? names.get(result.localSelection.connectionId) ||
                    result.localSelection.connectionId
                  : result.localSelection.status}
              </h3>
              <Text size="sm">{result.localSelection.reason.replaceAll('-', ' ')}</Text>
            </div>
            <div>
              <span>Served model</span>
              <strong>None</strong>
            </div>
            <div>
              <span>Upstream readiness</span>
              <strong>Unknown</strong>
            </div>
            <div>
              <span>Affinity</span>
              <strong>{result.affinity.source.replaceAll('-', ' ')}</strong>
              <Text size="sm">
                {result.affinity.action} · {result.affinity.reason}
              </Text>
            </div>
          </div>
          <div className={styles.panelBody}>
            <Table.ScrollContainer minWidth={670}>
              <Table aria-label="Captured candidate ordering">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Attempt order</Table.Th>
                    <Table.Th>Account</Table.Th>
                    <Table.Th>Captured load</Table.Th>
                    <Table.Th>Capacity</Table.Th>
                    <Table.Th>Quota evidence</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {result.candidates.map((candidate) => (
                    <Table.Tr
                      key={candidate.connectionId}
                      data-selected={
                        candidate.connectionId === result.localSelection.connectionId || undefined
                      }
                    >
                      <Table.Td className={styles.mono}>{candidate.order}</Table.Td>
                      <Table.Td>
                        <strong>
                          {names.get(candidate.connectionId) || candidate.connectionId}
                        </strong>
                        <Text size="sm" className={styles.mono}>
                          {candidate.connectionId}
                        </Text>
                      </Table.Td>
                      <Table.Td className={styles.mono}>
                        {candidate.activeLoad.inFlight} in flight
                      </Table.Td>
                      <Table.Td>
                        {candidate.capacity.gated ? candidate.capacity.limit : 'Ungated'}
                        {candidate.atCapacity ? ' · full' : ''}
                      </Table.Td>
                      <Table.Td>{candidate.quotaEvidence.replaceAll('-', ' ')}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {result.candidates.length === 0 && (
              <Text c="#5b6980" py="sm">
                No candidate order was produced on this capture.
              </Text>
            )}
            <div className={styles.evidenceGrid}>
              <div>
                <h3>Excluded accounts</h3>
                {result.exclusions.map((entry, index) => (
                  <p key={`${entry.connectionId}:${index}`}>
                    <strong>{names.get(entry.connectionId) || entry.connectionId}</strong>
                    <br />
                    {entry.reason.replaceAll('-', ' ')}
                  </p>
                ))}
                {result.exclusions.length === 0 && <p>No account exclusions recorded.</p>}
              </div>
              <div>
                <h3>Capability evidence</h3>
                <p>Context · {fit(result.capabilityFit.contextFitsDeclaredWindow)}</p>
                <p>Output · {fit(result.capabilityFit.outputFitsDeclaredLimit)}</p>
                <p>
                  Missing or unknown ·{' '}
                  {result.capabilityFit.missingOrUnknown.join(', ') ||
                    'None among supplied requirements'}
                </p>
                <p>These observations are not enforced as account-selection gates.</p>
              </div>
              <div>
                <h3>Unavailable decision inputs</h3>
                {result.unknownEvidence.map((value) => (
                  <p key={value}>{value.replaceAll('-', ' ')}</p>
                ))}
              </div>
            </div>
            {result.draftPreview && (
              <Alert
                color={result.draftPreview.valid ? 'blue' : 'orange'}
                title="Draft declaration only"
              >
                Account simulation does not apply this draft.{' '}
                {result.draftPreview.valid
                  ? 'The covered plan structure validates locally.'
                  : 'The declaration has local validation errors.'}
              </Alert>
            )}
            <details className={styles.receiptDetails}>
              <summary>Exact simulation receipt and ranking</summary>
              <pre>
                {JSON.stringify(
                  {
                    receipt: result.receipt,
                    ranking: result.ranking,
                    affinity: result.affinity,
                    draftPreview: result.draftPreview,
                  },
                  null,
                  2
                )}
              </pre>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}
