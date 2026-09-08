'use client';
import { useState } from 'react';
import { Alert, Button, Checkbox, FileInput, Group, Modal, NativeSelect, NumberInput, Stack, Table, Text, Textarea, TextInput } from '@mantine/core';
import { usePoll } from '@/shared/hooks/usePoll';
import { call } from '@/shared/api';
import { bulkDeleteUrl, diagnosticRows, modelKey, parseBulkImport, verifyCatalogAction } from './catalogToolsModel';
import styles from './catalogTools.module.css';

const time = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : 'Not recorded';
const failure = result => result.status === 0 ? 'The outcome is unconfirmed. Re-read the saved state before deciding whether to retry.' : `${result.body?.error || 'Request refused'} (HTTP ${result.status}).`;
const ITEMS = [['import', 'Import and delete custom models'], ['sync', 'Catalog metadata'], ['suggest', 'Suggested fallback plan'], ['cooldown', 'Model cooldowns and failures'], ['test', 'Explicit model diagnostics']];

function ReadFeedback({ resource }) {
  return resource.error ? <Alert color="red" title="Read failed">{failure({ status: resource.status, body: resource.error })}{resource.data ? ' The previous successful view remains visible.' : ''}</Alert> : resource.loading ? <Text role="status">Reading saved state…</Text> : null;
}

export function CatalogTools() {
  const custom = usePoll('/api/models/custom', 30000);
  const sync = usePoll('/api/models/catalog-sync', 30000);
  const availability = usePoll('/api/models/availability', 30000);
  const [native, setNative] = useState('[]');
  const [provider, setProvider] = useState('');
  const [type, setType] = useState('llm');
  const [selected, setSelected] = useState([]);
  const [limit, setLimit] = useState(5);
  const [suggestion, setSuggestion] = useState(null);
  const [planName, setPlanName] = useState('');
  const [planModels, setPlanModels] = useState('');
  const [testModels, setTestModels] = useState('');
  const [testKind, setTestKind] = useState('llm');
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [diagnostics, setDiagnostics] = useState(null);
  const rows = custom.data?.models || [];
  const providers = [...new Set(rows.map(model => model.providerAlias))];
  const candidates = rows.filter(model => model.providerAlias === provider && (model.type || 'llm') === type);

  function ask(action) { setError(null); setPending(action); }
  function prepareImport() {
    try { const models = parseBulkImport(native); ask({ kind: 'import', models, title: `Import ${models.length} custom models`, effect: 'Registers new provider/model/kind identities and capability overrides. Existing identities are retained without replacing their fields. Each entry can succeed or fail independently.', url: '/api/models/custom', options: { method: 'POST', body: { models } }, readUrl: '/api/models/custom' }); }
    catch (error) { setError(error.message); }
  }
  async function loadFile(file) {
    if (!file) return;
    try { setNative(await file.text()); setError(null); } catch { setError('The selected file could not be read.'); }
  }
  async function suggest() {
    setBusy(true); setError(null);
    const result = await call(`/api/combos/suggest?limit=${Math.min(20, Math.max(1, Number(limit) || 5))}`);
    setBusy(false);
    if (!result.ok) { setError(failure(result)); return; }
    setSuggestion(result.body); setPlanModels((result.body?.chain || []).join('\n'));
  }
  async function run() {
    if (!pending || busy) return;
    setBusy(true); setError(null);
    const action = pending;
    const result = await call(action.url, action.options);
    if (!result.ok) { setBusy(false); setError(failure(result)); return; }
    if (action.kind === 'test') {
      setDiagnostics(diagnosticRows(result.body, action.models)); setPending(null); setBusy(false); return;
    }
    const read = await call(action.readUrl);
    const verified = read.ok && verifyCatalogAction(action, result.body, read.body);
    const failed = (result.body?.results || []).filter(row => !row.success).length;
    setReceipt({ title: !verified ? 'Saved outcome needs verification' : failed ? 'Batch partially completed' : 'Saved state verified', warning: !verified || failed > 0, message: verified ? `${failed ? `${failed} entries were refused. ` : ''}The affected saved state was re-read. ${action.kind === 'cooldown' ? 'No matching active cooldown remains; this does not prove model access.' : ''}` : 'The action returned a response, but its saved outcome could not be verified. Re-read state before deciding whether to retry.', results: result.body?.results || null });
    custom.refresh(); sync.refresh(); availability.refresh();
    if (action.kind === 'delete' && verified) setSelected([]);
    setPending(null); setBusy(false);
  }
  const lines = value => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  return <Stack className={styles.tools} gap="lg">
    <div><h2>Catalog tools</h2><Text c="dimmed">Manage registered metadata and inspect local failures. Catalog synchronization and diagnostics contact external services only after explicit confirmation.</Text></div>
    {error && !pending && <Alert color="red" title="Action was not completed">{error}</Alert>}
    {receipt && <Alert color={receipt.warning ? 'yellow' : 'green'} title={receipt.title}><p>{receipt.message}</p>{receipt.results && <ul>{receipt.results.map((row, index) => <li key={index}><code>{row.id || `Entry ${index + 1}`}</code> · {row.success ? row.added === false ? 'Already registered; unchanged' : 'Accepted' : row.error || 'Refused'}</li>)}</ul>}</Alert>}
    <nav className={styles.sectionLinks} aria-label="Catalog tool sections">{ITEMS.map(([id, label]) => <a key={id} href={`#catalog-tool-${id}`}>{label}</a>)}</nav>
      {ITEMS.map(([id, label]) => <section key={id} id={`catalog-tool-${id}`} aria-labelledby={`catalog-tool-heading-${id}`} className={styles.toolSection}><h3 id={`catalog-tool-heading-${id}`}>{label}</h3>
        {id === 'import' && <Stack>
          <ReadFeedback resource={custom} />
          <Text>Import an array of up to 1000 objects. Fields include providerAlias, id, type, name, maxInputTokens, maxOutputTokens and vision. Token limits are positive integers; vision is boolean. Partial outcomes stay visible per entry.</Text>
          <FileInput label="Load model JSON from a file" accept="application/json,.json" onChange={loadFile} disabled={busy} />
          <Textarea label="Custom model JSON" value={native} onChange={event => setNative(event.currentTarget.value)} autosize minRows={7} maxRows={20} className={styles.code} disabled={busy} />
          <Group><Button onClick={prepareImport} disabled={busy}>Review bulk import</Button><Button variant="default" onClick={custom.refresh}>Re-read custom models</Button></Group>
          <h3>Delete registered models</h3>
          <Group grow><NativeSelect label="Registered provider" value={provider} onChange={event => { setProvider(event.currentTarget.value); setSelected([]); }} data={[{ value: '', label: 'Choose provider' }, ...providers]} /><TextInput label="Model kind" value={type} onChange={event => { setType(event.currentTarget.value); setSelected([]); }} /></Group>
          <Group><Button variant="subtle" disabled={busy || !candidates.length} onClick={() => setSelected(candidates.map(model => model.id))}>Select all in this provider and kind</Button><Button variant="subtle" disabled={busy || !selected.length} onClick={() => setSelected([])}>Clear model selection</Button><Text>{selected.length} selected</Text></Group>
          <div className={styles.records} role="region" aria-label="Registered models to delete" tabIndex={0}>{candidates.map(model => <Checkbox key={modelKey(model)} label={`${model.name || model.id} · ${model.id}`} checked={selected.includes(model.id)} onChange={event => setSelected(event.currentTarget.checked ? [...selected, model.id] : selected.filter(id => id !== model.id))} />)}{!candidates.length && <Text c="dimmed">No registered models in this provider and kind.</Text>}</div>
          <Button variant="default" color="red" disabled={busy || !selected.length} onClick={() => ask({ kind: 'delete', provider, type, ids: selected, title: `Delete ${selected.length} registered models`, effect: 'Removes only the selected custom catalog records for this provider and kind. Provider accounts and built-in catalog entries remain. Re-import their original definitions to restore them.', url: bulkDeleteUrl(provider, type, selected), options: { method: 'DELETE' }, readUrl: '/api/models/custom' })}>Review bulk deletion</Button>
        </Stack>}
        {id === 'sync' && <Stack><ReadFeedback resource={sync} />{sync.data && <dl className={styles.facts}>
          <dt>Source</dt><dd>{sync.data.url}</dd><dt>Last successful check (UTC)</dt><dd>{time(sync.data.lastSync)}</dd><dt>Schedule</dt><dd>{sync.data.scheduled ? `Enabled · ${Number(sync.data.intervalMs) / 3600000} hours` : 'Not scheduled in this process'}</dd><dt>Current check</dt><dd>{sync.data.running ? 'Running' : 'Idle'}</dd><dt>Retained metadata</dt><dd>{sync.data.catalog ? `${sync.data.catalog.models} model overrides · ${sync.data.catalog.providers} providers · ${sync.data.catalog.bytes} bytes` : 'No readable catalog file'}</dd><dt>File saved (UTC)</dt><dd>{time(sync.data.catalog?.syncedAt)}</dd><dt>Last error</dt><dd>{sync.data.lastError || 'None recorded'}</dd>
        </dl>}<Text>Refreshes metadata from models.dev and stores capability overrides. This does not test entitlement or run inference. The background schedule is controlled by the installation.</Text><Group><Button disabled={busy || sync.data?.running} onClick={() => ask({ kind: 'sync', previousSync: sync.data?.lastSync, title: 'Refresh catalog metadata', effect: 'Downloads models.dev catalog metadata and persists changed capability overrides. A failed check retains the previous catalog; no provider inference is sent.', url: '/api/models/catalog-sync', options: { method: 'POST' }, readUrl: '/api/models/catalog-sync' })}>Review catalog refresh</Button><Button variant="default" onClick={sync.refresh}>Re-read metadata</Button></Group></Stack>}
        {id === 'suggest' && <Stack><Text>Build an advisory chain from the local advertised model list and known availability exclusions. Tier and context ordering do not establish actual entitlement. If availability cannot be read, the endpoint proceeds with no known exclusions.</Text><NumberInput label="Maximum plan members" min={1} max={20} allowDecimal={false} value={limit} onChange={setLimit} /><Button disabled={busy} onClick={suggest}>Suggest a fallback plan</Button>{suggestion && <><Text>{suggestion.counted} classified candidates. No plan has been saved.</Text><details><summary>Inspect tier membership</summary><pre className={styles.code}>{JSON.stringify(suggestion.tiers, null, 2)}</pre></details><TextInput label="New plan name" value={planName} onChange={event => setPlanName(event.currentTarget.value)} /><Textarea label="Ordered plan members" description="One full model ID per line. Edit the suggested chain before saving." value={planModels} onChange={event => setPlanModels(event.currentTarget.value)} autosize minRows={3} /><Button disabled={busy || !/^[a-zA-Z0-9_.-]+$/.test(planName) || !lines(planModels).length} onClick={() => ask({ kind: 'plan', name: planName, models: lines(planModels), title: 'Create this fallback plan', effect: 'Saves a new LLM plan with these ordered members. New requests using the plan name can route through them under the configured plan strategy. Review its strategy in Plans after saving. Existing plan names are refused.', url: '/api/combos', options: { method: 'POST', body: { name: planName, models: lines(planModels), kind: 'llm' } }, readUrl: '/api/combos' })}>Review suggested plan</Button></>}</Stack>}
        {id === 'cooldown' && <Stack><ReadFeedback resource={availability} /><Text>Cooldown clearance applies to this provider/model across every matching account. It removes local lock metadata and can reset an unavailable account status; it does not repair credentials or prove access.</Text><Button variant="default" onClick={availability.refresh}>Re-read model failures</Button><div className={styles.records} role="region" aria-label="Model failures" tabIndex={0}>{(availability.data?.models || []).map((model, index) => <article key={`${model.connectionId}/${model.model}/${index}`}><h3>{model.connectionName}</h3><p><code>{model.provider}/{model.model}</code> · {model.status}</p>{model.until && <p>Cooldown until {time(model.until)} UTC</p>}{model.lastError && <p>{model.lastError}</p>}{model.status === 'cooldown' ? <Button variant="default" disabled={busy} onClick={() => ask({ kind: 'cooldown', provider: model.provider, model: model.model, title: 'Clear this provider/model cooldown', effect: `Clears ${model.provider}/${model.model} locks across all matching accounts, not just ${model.connectionName}. This can make requests eligible immediately. Provider limits may still refuse the next request.`, url: '/api/models/availability', options: { method: 'POST', body: { action: 'clearCooldown', provider: model.provider, model: model.model } }, readUrl: '/api/models/availability' })}>Review cooldown clearance</Button> : <Text c="dimmed">No active lock to clear. Review this account in Connections.</Text>}</article>)}{availability.data && !availability.data.models?.length && <Text>No local cooldown or unavailable records reported. This does not establish that all models are usable.</Text>}</div></Stack>}
        {id === 'test' && <Stack><Text>This diagnostic uses the server’s internal gateway path and first active stored client key when available. It can contact providers, consume quota and incur charges. It does not test a client key you enter in Requests. Batch models run sequentially.</Text><Textarea label="Diagnostic model IDs" description="One full model ID per line." value={testModels} onChange={event => setTestModels(event.currentTarget.value)} autosize minRows={3} /><NativeSelect label="Diagnostic kind" data={[{ value: 'llm', label: 'Chat' }, { value: 'embedding', label: 'Embedding' }, { value: 'image', label: 'Image generation' }, { value: 'stt', label: 'Transcription of built-in silent audio' }]} value={testKind} onChange={event => setTestKind(event.currentTarget.value)} /><Textarea label="Optional diagnostic prompt" description={testKind === 'stt' ? 'Transcription uses the built-in silent audio; this prompt is not sent.' : 'Leave blank for the handler’s small built-in prompt.'} value={prompt} onChange={event => setPrompt(event.currentTarget.value)} disabled={testKind === 'stt'} autosize minRows={2} /><Button disabled={busy || !lines(testModels).length} onClick={() => ask({ kind: 'test', models: lines(testModels), title: `Send ${lines(testModels).length} model diagnostics`, effect: 'Sends real gateway requests sequentially using stored credentials. Provider work and billed usage cannot be undone. An interrupted browser wait does not guarantee provider cancellation; no automatic retry is performed.', url: '/api/models/test', options: { method: 'POST', body: { models: lines(testModels), kind: testKind, ...(prompt.trim() && testKind !== 'stt' ? { prompt } : {}) } } })}>Review diagnostic sends</Button>{diagnostics && <Table.ScrollContainer minWidth={560}><Table captionSide="top"><Table.Caption>Diagnostic responses, not a promise about future requests</Table.Caption><Table.Thead><Table.Tr><Table.Th>Model</Table.Th><Table.Th>Outcome</Table.Th><Table.Th>Latency (ms)</Table.Th><Table.Th>Response preview or error</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{diagnostics.map((row, index) => <Table.Tr key={index}><Table.Td><code>{row.model}</code></Table.Td><Table.Td>{row.ok ? 'Response validated' : 'Failed'}</Table.Td><Table.Td>{row.latencyMs ?? 'Not reported'}</Table.Td><Table.Td>{row.preview || row.error || 'Not reported'}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}</Stack>}
      </section>)}
    <Modal opened={Boolean(pending)} onClose={() => { if (!busy) setPending(null); }} title={pending?.title} closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}>
      <Stack><Text>{pending?.effect}</Text>{pending?.kind === 'delete' && <ul>{pending.ids.map(id => <li key={id}><code>{id}</code></li>)}</ul>}{pending?.kind === 'plan' && <ol>{pending.models.map((id, index) => <li key={index}><code>{id}</code></li>)}</ol>}{error && <Alert color="red" title="Action was not completed">{error}</Alert>}<Group justify="flex-end"><Button variant="default" disabled={busy} onClick={() => setPending(null)}>Cancel</Button><Button disabled={busy} onClick={run}>{busy ? 'Waiting for outcome' : pending?.kind === 'test' ? 'Send diagnostics' : 'Confirm action'}</Button></Group></Stack>
    </Modal>
  </Stack>;
}
