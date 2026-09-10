'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Accordion,
  ActionIcon,
  Autocomplete,
  Badge,
  Button,
  FileInput,
  Group,
  NativeSelect,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  Card,
  DensitySwitch,
  EvidenceLine,
  StateWord,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';
import board from '@/shared/workspace/board.module.css';
import shared from '@/shared/workspace/workspace.module.css';
import {
  OPERATIONS,
  UNAVAILABLE,
  VOICE_PROVIDERS,
  operationById,
  initialDraft,
  parseBody,
  fieldValue,
  changeField,
  prepareRequest,
  sendGateway,
  redactText,
  diagnosticExport,
  MAX_RESPONSE_BYTES,
} from './contracts';
import { localCatalogue, operationProviders } from './catalog';
import styles from './requestWorkbench.module.css';

const labels = {
  message: 'User message',
  content: 'User content',
  input: 'Input text',
  prompt: 'Prompt',
  query: 'Query',
  documents: 'Documents, one per line',
  documentUrl: 'Document URL',
  url: 'Public page URL',
  language: 'Language',
  style: 'Voice instructions',
};
const GROUPS = [...new Set(OPERATIONS.map((operation) => operation.group))];
const GROUP_ICONS = {
  Conversation: 'i-context',
  Images: 'i-models',
  'Text analysis': 'i-usage',
  Audio: 'i-sessions',
  Web: 'i-network',
  Video: 'i-now',
};

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// One gateway operation, in the level's own shape. The state word says whether
// it is the operation on the bench, and the lines carry what local metadata
// establishes: the bundled provider list and whether an upload is required.
const WIDEST = Math.max(
  1,
  ...OPERATIONS.map((operation) => operationProviders(operation).length)
);

// One gateway operation. The bar is the share of the bundled provider
// catalogue that declares this action, which is breadth, never entitlement.
function OperationEvidence({ operation, providers }) {
  return (
    <EvidenceLine
      label="Providers"
      shares={[{ kind: 'input', percent: (providers.length / WIDEST) * 100 }]}
      value={String(providers.length)}
      note={operation.files ? `${operation.files} upload` : 'bundled'}
      title={
        providers.length
          ? `Bundled catalogue only: ${providers.slice(0, 8).join(', ')}${providers.length > 8 ? ', …' : ''}. It does not prove a connected account or entitlement.`
          : 'No bundled provider declares this action. Enter an exact supported provider/model.'
      }
    />
  );
}

export function RequestWorkbench() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const operation = operationById(params.get('operation'));
  const [drafts, setDrafts] = useState({});
  const draft = drafts[operation.id] || initialDraft(operation);
  const [clientKey, setClientKey] = useState('');
  const [validation, setValidation] = useState(null);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(null);
  const pending = useRef(null);
  const resultRef = useRef(null);
  const models = useMemo(() => localCatalogue(operation), [operation]);
  const providers = useMemo(() => operationProviders(operation), [operation]);
  let body = null,
    bodyError = null;
  try {
    body = parseBody(draft.native);
  } catch (error) {
    bodyError = error.message;
  }
  const selectedModel =
    operation.id === 'gemini' ? draft.model : typeof body?.model === 'string' ? body.model : '';
  const metadata = models.find((model) => model.id === selectedModel);
  const patch = (values) => {
    setDrafts((previous) => ({
      ...previous,
      [operation.id]: { ...(previous[operation.id] || initialDraft(operation)), ...values },
    }));
    setValidation(null);
  };
  const updateBody = (field, value) => {
    if (body) patch({ native: JSON.stringify(changeField(body, field, value), null, 2) });
  };
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [operation.id]
  );

  function selectOperation(id) {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setClientKey('');
    setValidation(null);
    setFailure(null);
    setResult(null);
    setProgress(null);
    const next = new URLSearchParams(params.toString());
    next.set('operation', id);
    router.replace(`${pathname}?${next}`, { scroll: false });
  }

  function validate() {
    try {
      const prepared = prepareRequest(operation, draft);
      setValidation({
        ok: true,
        prepared,
        message:
          'Local shape, required fields, header values and upload sizes passed. Provider applicability, sign-in material, byte signatures, budgets and upstream acceptance have not been tested.',
      });
      return prepared;
    } catch (error) {
      setValidation({ ok: false, message: error.message });
      return null;
    }
  }

  async function send() {
    if (pending.current) return;
    const prepared = validate();
    if (!prepared) return;
    if (!clientKey.trim()) {
      setFailure(
        'Enter a client API key. The operator session does not replace gateway client authorization.'
      );
      return;
    }
    const secret = clientKey;
    setClientKey('');
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure(null);
    setResult(null);
    setProgress({ bytes: 0, text: '' });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException('The local five-minute response deadline expired.', 'TimeoutError')
        ),
      300000
    );
    try {
      const response = await sendGateway(prepared, {
        clientKey: secret,
        signal: controller.signal,
        onProgress: (value) => {
          if (pending.current === controller) setProgress(value);
        },
      });
      if (pending.current === controller)
        setResult({ ...response, model: redactText(prepared.model || '', [secret]) });
    } catch (error) {
      if (pending.current === controller)
        setFailure(
          controller.signal.aborted
            ? 'Observation stopped. The gateway or provider may already have accepted work. No request was replayed and an upstream video job was not cancelled.'
            : `Transport failed or was interrupted. The outcome may be uncertain; no automatic replay occurred. ${redactText(error.message, [secret])}`
        );
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
        resultRef.current?.focus();
      }
    }
  }

  const resultJobId = typeof result?.data?.request_id === 'string' ? result.data.request_id : null;
  function inspectJob() {
    const target = operationById('video-poll');
    setDrafts((previous) => ({
      ...previous,
      'video-poll': {
        ...initialDraft(target),
        jobId: resultJobId,
        connection: result.connectionId,
      },
    }));
    selectOperation('video-poll');
  }
  const preparedPreview = (() => {
    try {
      return prepareRequest(operation, draft);
    } catch {
      return null;
    }
  })();

  const text = query.trim().toLowerCase();
  const active = group || operation.group;
  const visible = OPERATIONS.filter(
    (item) =>
      (text ? item.group === (group || item.group) : item.group === active) &&
      `${item.label} ${item.path} ${item.group}`.toLowerCase().includes(text)
  );
  const drafted = (item) => Boolean(drafts[item.id]);
  const operationState = (item) =>
    item.id === operation.id
      ? { word: 'On the bench', tone: 'positive' }
      : drafted(item)
        ? { word: 'Draft kept', tone: 'ember' }
        : { word: 'Available', tone: null };

  const operationsBoard = (
    <Board label="Gateway operations" advanced={advanced} density={density} compare="none">
      <BoardSummary
        label="Operation summary"
        active={group}
        onPick={(next) => setGroup(next === group ? null : next)}
        chips={GROUPS.map((name) => ({
          id: name,
          label: name.toLowerCase(),
          tone: name === operation.group ? 'positive' : null,
          count: OPERATIONS.filter((item) => item.group === name).length,
        }))}
        note={`On the bench · ${operation.label}`}
      />
      <BoardToolbar
        search={query}
        onSearch={setQuery}
        searchLabel="Search gateway operations"
        actions={
          <>
            <DensitySwitch value={density} onChange={setDensity} />
            <Tooltip label="Open the local compatibility fixtures">
              <ActionIcon
                component={Link}
                href="/dashboard/compatibility"
                variant="default"
                aria-label="Open local compatibility"
              >
                <Icon name="i-compatibility" />
              </ActionIcon>
            </Tooltip>
          </>
        }
      />
      {advanced ? (
        <div className={board.head} aria-hidden="true">
          <span />
          <span>Operation</span>
          <span>State</span>
          <span>Bundled evidence</span>
          <span>Endpoint</span>
          <span>Select</span>
        </div>
      ) : null}
      {!advanced
        ? GROUPS.filter((name) => visible.some((item) => item.group === name)).map((name) => {
            const members = visible.filter((item) => item.group === name);
            return (
              <BoardGroup
                key={name}
                label={name}
                tone={name === operation.group ? 'positive' : null}
                count={members.length}
              >
                {members.map((item) => {
                  const state = operationState(item);
                  return (
                    <Card
                      key={item.id}
                      id={item.id}
                      bucket={item.id === operation.id ? 'selected' : 'available'}
                      label={item.label}
                      head={
                        <>
                          <Icon name={GROUP_ICONS[item.group]} />
                          <div className={board.identityText}>
                            <button
                              type="button"
                              className={board.nameButton}
                              aria-pressed={item.id === operation.id}
                              onClick={() => selectOperation(item.id)}
                            >
                              {item.label}
                            </button>
                            <small>{item.path}</small>
                          </div>
                        </>
                      }
                      state={
                        <>
                          <StateWord tone={state.tone}>{state.word}</StateWord>
                          <span className={board.spacer} />
                          <span className={board.cardAttempts}>{item.method || 'POST'}</span>
                        </>
                      }
                    >
                      <OperationEvidence
                        operation={item}
                        providers={item.id === operation.id ? providers : operationProviders(item)}
                      />
                    </Card>
                  );
                })}
              </BoardGroup>
            );
          })
        : null}
      <div className={board.rows} hidden={!advanced}>
        {advanced
          ? visible.map((item) => {
              const state = operationState(item);
              return (
                <article
                  key={item.id}
                  className={board.row}
                  data-expanded={item.id === operation.id || undefined}
                  data-bucket={item.id === operation.id ? 'selected' : 'available'}
                  aria-label={item.label}
                >
                  <div className={board.main}>
                    <span className={board.caret} aria-hidden="true">
                      <Icon name={GROUP_ICONS[item.group]} />
                    </span>
                    <div className={board.identity}>
                      <div className={board.identityText}>
                        <button
                          type="button"
                          className={board.nameButton}
                          aria-pressed={item.id === operation.id}
                          onClick={() => selectOperation(item.id)}
                        >
                          {item.label}
                        </button>
                        <small>{item.group}</small>
                      </div>
                    </div>
                    <div className={board.state}>
                      <StateWord tone={state.tone}>{state.word}</StateWord>
                    </div>
                    <div className={board.quota}>
                      <OperationEvidence operation={item} providers={operationProviders(item)} />
                    </div>
                    <div className={board.activity}>
                      <span>{item.method || 'POST'}</span>
                      <small>{item.path}</small>
                    </div>
                    <div className={board.actions}>
                      <Button
                        size="compact-xs"
                        variant={item.id === operation.id ? 'light' : 'default'}
                        aria-label={`Put ${item.label} on the bench`}
                        onClick={() => selectOperation(item.id)}
                      >
                        {item.id === operation.id ? 'On the bench' : 'Select'}
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })
          : null}
      </div>
      <div className={board.messages}>
        {!visible.length ? (
          <div className={board.empty}>
            No operation matches.{' '}
            <button
              type="button"
              className={board.linkButton}
              onClick={() => {
                setQuery('');
                setGroup(null);
              }}
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </div>
    </Board>
  );

  return (
    <div className={`${shared.lensPage} ${styles.workbench}`} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Request workbench</h1>
          <p>
            {advanced ? 'Advanced' : 'Everyday'} · inspect a native gateway request, then send it
            deliberately
          </p>
        </div>
        <Badge variant="light" size="lg" className={styles.endpointBadge}>
          {operation.method || 'POST'} {operation.path}
          {operation.id === 'video-poll'
            ? '{request_id}'
            : operation.id === 'gemini'
              ? '{model}:generateContent'
              : ''}
        </Badge>
      </div>
      <div className={`${shared.lensBody} ${styles.body}`}>
        {operationsBoard}
        <div className={styles.layout}>
        <section className={styles.panel} aria-labelledby="request-input-title">
          <div className={styles.panelHead}>
            <h2 id="request-input-title">Compose {operation.label.toLowerCase()}</h2>
            <span className={styles.secondary}>Draft stays in this page’s memory</span>
          </div>
          <Stack gap="xs" p="sm">
            <Text size="xs" c="dimmed">
              {operation.help}
            </Text>
            {!operation.method && (
              <Autocomplete
                size="xs"
                label="Routed model or combo"
                description="Bundled catalogue metadata only. A listed model does not prove account readiness or entitlement. Enter a configured custom model or supported combo when absent."
                data={models.map((model) => model.id)}
                limit={30}
                value={selectedModel}
                disabled={busy || Boolean(bodyError)}
                onChange={(value) =>
                  operation.id === 'gemini' ? patch({ model: value }) : updateBody('model', value)
                }
                placeholder="provider/model or configured combo"
              />
            )}
            {metadata && (
              <div className={styles.metadata}>
                <strong>{metadata.name || metadata.id}</strong>
                <span>
                  {metadata.providerLabel} · {operation.kind}
                </span>
                {metadata.params?.length ? <span>Native options · {metadata.params.join(', ')}</span> : null}
                {metadata.contextWindow ? (
                  <span>Declared context window · {metadata.contextWindow.toLocaleString()} tokens</span>
                ) : null}
                {metadata.capabilities ? (
                  <details>
                    <summary>Declared capabilities</summary>
                    <pre>{JSON.stringify(metadata.capabilities, null, 2)}</pre>
                  </details>
                ) : null}
              </div>
            )}
            {!operation.method && !metadata && selectedModel && (
              <Text size="xs" c="dimmed">
                No exact bundled metadata for this ID. The gateway must resolve its configured
                provider, alias or combo; local validation cannot establish support.
              </Text>
            )}
            {operation.id === 'voices' && (
              <NativeSelect
                size="xs"
                label="Voice provider"
                value={draft.provider}
                data={[{ value: '', label: 'Choose a supported provider' }, ...VOICE_PROVIDERS]}
                onChange={(event) => patch({ provider: event.currentTarget.value })}
                disabled={busy}
              />
            )}
            {operation.fields.map((field) =>
              field === 'language' && operation.id === 'voices' ? (
                <TextInput
                  size="xs"
                  key={field}
                  label="Language filter"
                  value={draft.language}
                  onChange={(event) => patch({ language: event.currentTarget.value })}
                  disabled={busy}
                />
              ) : (
                <Textarea
                  size="xs"
                  key={field}
                  label={labels[field]}
                  description={
                    ['message', 'content'].includes(field)
                      ? 'Editing this guided input replaces the conversation with one user message. Use the native body for multi-turn, image and tool content.'
                      : undefined
                  }
                  value={fieldValue(body || {}, field)}
                  minRows={['message', 'content', 'input', 'prompt', 'documents'].includes(field) ? 3 : 1}
                  maxRows={8}
                  autosize
                  disabled={busy || Boolean(bodyError)}
                  onChange={(event) => updateBody(field, event.currentTarget.value)}
                />
              )
            )}
            {operation.id === 'video-poll' && (
              <TextInput
                size="xs"
                label="Video request ID"
                description="Exact request_id from the create response, including any veo: prefix."
                value={draft.jobId}
                onChange={(event) => patch({ jobId: event.currentTarget.value })}
                disabled={busy}
              />
            )}
            {operation.files && (
              <>
                <NativeSelect
                  size="xs"
                  label="Request encoding"
                  data={
                    operation.id === 'transcription'
                      ? [{ value: 'multipart', label: 'Multipart upload' }]
                      : [
                          { value: 'json', label: 'Native JSON' },
                          { value: 'multipart', label: 'Multipart upload' },
                        ]
                  }
                  value={draft.encoding}
                  onChange={(event) => patch({ encoding: event.currentTarget.value })}
                  disabled={busy}
                />
                {draft.encoding === 'multipart' && (
                  <>
                    <FileInput
                      size="xs"
                      label={
                        operation.files === 'audio'
                          ? 'Audio file'
                          : operation.files === 'image'
                            ? 'Source images'
                            : 'Source media files'
                      }
                      placeholder="Select local files"
                      multiple={operation.files !== 'audio'}
                      clearable
                      accept={
                        operation.files === 'image'
                          ? 'image/png,image/jpeg,image/webp,image/gif'
                          : operation.files === 'audio'
                            ? 'audio/*'
                            : undefined
                      }
                      value={operation.files === 'audio' ? draft.files[0] || null : draft.files}
                      onChange={(files) =>
                        patch({
                          files:
                            operation.files === 'audio' ? (files ? [files] : []) : files,
                        })
                      }
                      disabled={busy}
                    />
                    {operation.files === 'video' && (
                      <TextInput
                        size="xs"
                        label="Native multipart file field"
                        description="Use the field name required by the xAI action. JSON fields above are encoded as multipart text fields."
                        value={draft.fileField}
                        onChange={(event) => patch({ fileField: event.currentTarget.value })}
                        disabled={busy}
                      />
                    )}
                  </>
                )}
              </>
            )}
            {operation.id === 'gemini' || operation.kind === 'image' ? (
              <Switch
                size="xs"
                label="Request streaming response"
                checked={draft.stream}
                onChange={(event) => patch({ stream: event.currentTarget.checked })}
                disabled={busy}
              />
            ) : ['chat', 'responses', 'messages', 'ollama'].includes(operation.id) ? (
              <Switch
                size="xs"
                label="Request streaming response"
                checked={body?.stream === true}
                onChange={(event) => updateBody('stream', event.currentTarget.checked)}
                disabled={busy || Boolean(bodyError)}
              />
            ) : null}
            {operation.id === 'speech' && (
              <Autocomplete
                size="xs"
                label="Response format (query parameter)"
                description="mp3 is the gateway default; json returns base64 audio. Other formats depend on the selected adapter."
                value={draft.responseFormat}
                data={['mp3', 'json', 'wav', 'opus', 'aac', 'flac', 'pcm']}
                onChange={(value) => patch({ responseFormat: value })}
                disabled={busy}
              />
            )}
            {operation.kind === 'image' && (
              <NativeSelect
                size="xs"
                label="Response transport"
                value={draft.responseFormat}
                data={[
                  { value: '', label: 'Native JSON or requested event stream' },
                  { value: 'binary', label: 'Binary image bytes' },
                ]}
                onChange={(event) => patch({ responseFormat: event.currentTarget.value })}
                disabled={busy}
              />
            )}
            {operation.connection && (
              <TextInput
                size="xs"
                label={
                  operation.id === 'video-poll'
                    ? 'Creation account ID'
                    : 'Preferred account ID (optional)'
                }
                description={
                  operation.id === 'video-poll'
                    ? 'Return x-tokenproxy-connection-id from creation. Without it the handler defaults to xAI; Gemini jobs require their account binding.'
                    : `Sent only as ${operation.connection}; provider readiness is checked by the gateway.`
                }
                value={draft.connection}
                onChange={(event) => patch({ connection: event.currentTarget.value })}
                disabled={busy}
              />
            )}
            {operation.kind === 'video' && operation.id !== 'video-poll' && (
              <TextInput
                size="xs"
                label="Idempotency key (optional)"
                description="Forwarded to the provider. Keep the same value when investigating an uncertain create; the workbench never resends automatically."
                value={draft.idempotency}
                onChange={(event) => patch({ idempotency: event.currentTarget.value })}
                disabled={busy}
              />
            )}
            {!operation.method && (
              <Accordion variant="contained" defaultValue={advanced ? 'native' : undefined}>
                <Accordion.Item value="native">
                  <Accordion.Control>Native body and advanced options</Accordion.Control>
                  <Accordion.Panel>
                    <Textarea
                      size="xs"
                      aria-label="Native request JSON"
                      className={styles.native}
                      value={draft.native}
                      onChange={(event) => patch({ native: event.currentTarget.value })}
                      error={bodyError}
                      autosize
                      minRows={8}
                      maxRows={24}
                      disabled={busy}
                      spellCheck={false}
                    />
                    <Text size="xs" c="dimmed" mt="xs">
                      This is the body that will be sent. Provider options are not interchangeable;
                      the gateway and adapter perform final validation. Files are uploaded only with
                      the request.
                    </Text>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            )}
            <details>
              <summary>Inspect request envelope</summary>
              <pre className={styles.code} tabIndex={0} aria-label="Request preview">
                {JSON.stringify(
                  {
                    method: operation.method || 'POST',
                    url: preparedPreview?.url || operation.path,
                    headers: {
                      ...(preparedPreview?.headers || {}),
                      Authorization: 'Bearer [entered only at send time]',
                    },
                    encoding: draft.encoding,
                    uploadedFiles: draft.files.map((file) => ({ size: file.size, type: file.type })),
                    body: body || '[invalid JSON]',
                  },
                  null,
                  2
                )}
              </pre>
            </details>
            <TextInput
              size="xs"
              type="password"
              label="Client API key"
              description="Write-only, transient and cleared when a request starts. Never saved, copied, placed in a URL or included in diagnostic exports."
              autoComplete="off"
              spellCheck={false}
              value={clientKey}
              onChange={(event) => setClientKey(event.currentTarget.value)}
              disabled={busy}
            />
            <div className={styles.effect}>
              <Icon name="i-warning" />
              <p>
                Sending contacts this gateway and may call providers, spend quota or money, create
                jobs, and refresh stored provider authorization. Key restrictions and budgets still
                apply. Some nonchat routes refuse budget-limited keys when durable accounting is
                unavailable.
              </p>
            </div>
            {validation && (
              <Notice
                tone={validation.ok ? 'ok' : 'bad'}
                title={validation.ok ? 'Locally valid' : 'Request needs correction'}
                detail={validation.message}
              />
            )}
            <Group gap="xs">
              <Button size="xs" onClick={send} disabled={busy || !clientKey.trim()}>
                Send gateway request
              </Button>
              <Button size="xs" variant="default" onClick={validate} disabled={busy}>
                Validate locally
              </Button>
              {busy && (
                <Button size="xs" variant="default" onClick={() => pending.current?.abort()}>
                  Stop waiting
                </Button>
              )}
            </Group>
            {!clientKey.trim() && !busy && (
              <Text size="xs" c="dimmed">
                Enter a client key to enable sending. Local inspection and validation do not require
                one.
              </Text>
            )}
          </Stack>
        </section>
        <section className={styles.panel} aria-labelledby="request-result-title">
          <div className={styles.panelHead}>
            <h2 id="request-result-title" tabIndex={-1} ref={resultRef}>
              Response evidence
            </h2>
            <StateWord
              tone={busy ? 'ember' : result ? (result.ok ? 'positive' : 'refusal') : failure ? 'refusal' : null}
            >
              {busy
                ? 'Awaiting response'
                : result
                  ? `HTTP ${result.status}`
                  : failure
                    ? 'Uncertain outcome'
                    : 'No request sent'}
            </StateWord>
          </div>
          <Stack p="sm" gap="xs">
            {failure && (
              <Notice tone="bad" title="Request did not complete in this view" detail={failure} />
            )}
            {!result && !busy && !failure && (
              <div className={styles.empty}>
                <Icon name="i-context" />
                <h3>Inspect before you send</h3>
                <p>
                  Compose and validate locally. An explicit gateway response will appear here with
                  its actual HTTP status, body and bounded evidence.
                </p>
                <p>No provider requests run when you open this page.</p>
              </div>
            )}
            {busy && (
              <Text size="xs" role="status">
                Receiving {progress?.bytes?.toLocaleString() || 0} bytes. Leaving this page stops
                observation; upstream work may already exist.
              </Text>
            )}
            {result && (
              <>
                <Notice
                  tone={!result.ok ? 'bad' : result.truncated ? 'warn' : 'ok'}
                  title={
                    result.ok
                      ? result.operation.startsWith('video-') && result.operation !== 'video-poll'
                        ? 'Gateway accepted the video request'
                        : 'Gateway returned a response'
                      : 'Gateway refused or failed the request'
                  }
                  detail={
                    result.truncated
                      ? `Response reached the local ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB bound. Reading stopped; the retained response is incomplete.`
                      : 'HTTP success does not prove completion of the user’s task or confirm an upstream invoice.'
                  }
                />
                {result.viewTruncated && (
                  <Text size="xs">
                    The view shows the first 100,000 characters. The bounded complete response
                    remains available to download when reception completed.
                  </Text>
                )}
                <dl className={styles.facts}>
                  <div>
                    <dt>Operation</dt>
                    <dd>{operationById(result.operation).label}</dd>
                  </div>
                  <div>
                    <dt>Model requested</dt>
                    <dd>{result.model || 'Not supplied'}</dd>
                  </div>
                  <div>
                    <dt>Content type</dt>
                    <dd>{result.contentType}</dd>
                  </div>
                  <div>
                    <dt>Retained bytes</dt>
                    <dd>{result.bytes.toLocaleString()}</dd>
                  </div>
                  {result.requestId && (
                    <div>
                      <dt>Request reference</dt>
                      <dd>{result.requestId}</dd>
                    </div>
                  )}
                  {result.connectionId && (
                    <div>
                      <dt>Video account binding</dt>
                      <dd>{result.connectionId}</dd>
                    </div>
                  )}
                </dl>
                {resultJobId && (
                  <>
                    <Text size="xs">
                      Job status ·{' '}
                      {typeof result.data.status === 'string' ? result.data.status : 'Not reported'}.
                      Check once to read the provider’s current state.
                    </Text>
                    <Button size="xs" variant="default" onClick={inspectJob}>
                      Prepare status check
                    </Button>
                  </>
                )}
                {result.blob && (
                  <>
                    <Text size="xs">
                      Response retained in this page’s memory. No external media URL was fetched.
                      Text responses have sensitive patterns redacted.
                    </Text>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() =>
                        download(
                          result.blob,
                          `gateway-response.${
                            result.text
                              ? 'txt'
                              : {
                                  'audio/mpeg': 'mp3',
                                  'audio/wav': 'wav',
                                  'image/png': 'png',
                                  'image/jpeg': 'jpg',
                                  'image/webp': 'webp',
                                  'video/mp4': 'mp4',
                                }[result.contentType.split(';')[0]] || 'bin'
                          }`
                        )
                      }
                    >
                      Download response body
                    </Button>
                  </>
                )}
                <Button
                  size="xs"
                  variant="default"
                  onClick={() =>
                    download(
                      new Blob([JSON.stringify(diagnosticExport(result), null, 2)], {
                        type: 'application/json',
                      }),
                      'request-diagnostic.json'
                    )
                  }
                >
                  Export redacted diagnostic
                </Button>
              </>
            )}
            {(result?.text || progress?.text) && (
              <pre className={styles.code} tabIndex={0} aria-label="Bounded native response">
                {result?.text || progress.text}
              </pre>
            )}
            <div className={styles.limits}>
              <EvidenceLine
                label="Applicability"
                shares={[{ kind: 'input', percent: (providers.length / WIDEST) * 100 }]}
                value={providers.length ? String(providers.length) : 'None'}
                note="bundled providers"
                title={
                  providers.length
                    ? providers.join(', ')
                    : 'No bundled provider declares this action. Enter an exact supported provider/model.'
                }
              />
              <Text size="xs" c="dimmed">
                Catalogue declarations do not prove a connected account, authorization, model
                entitlement or supported native option.{' '}
                <Link href="/dashboard/connections">Inspect connections</Link> and{' '}
                <Link href="/dashboard/models">model policy</Link>.
              </Text>
              <details>
                <summary>Unavailable standalone capabilities</summary>
                <Stack gap="xs" mt="xs">
                  {UNAVAILABLE.map((item) => (
                    <div key={item.label}>
                      <strong>{item.label}</strong>
                      <p>{item.reason}</p>
                    </div>
                  ))}
                </Stack>
              </details>
            </div>
          </Stack>
        </section>
        </div>
      </div>
    </div>
  );
}
