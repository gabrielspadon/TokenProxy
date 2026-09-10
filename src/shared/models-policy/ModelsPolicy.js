'use client';
import { cloneElement, useState } from 'react';
import { Alert, Badge, Button, Group, Modal, Stack, Table, Tabs, Text } from '@mantine/core';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { useResource } from '@/shared/workspace/useResource';
import { useDensity, useLevel } from '@/shared/workspace/Board';
import shared from '@/shared/workspace/workspace.module.css';
import { PolicyEditor } from './PolicyEditor';
import { PolicyHistory } from './PolicyHistory';
import { ConfigurationDomains } from './ConfigurationDomains';
import { RoutingSimulator } from './RoutingSimulator';
import { CascadePolicy } from './CascadePolicy';
import { PlanTransfer } from './PlanTransfer';
import { policyRequest, shortHash } from './policyModel';
import styles from './policy.module.css';

function Differences({ changes }) {
  return (
    <Table.ScrollContainer minWidth={550} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Scroll configuration differences', className: styles.tableViewport } }}>
      <Table aria-label="Covered configuration changes" className={styles.diffTable}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Covered path</Table.Th>
            <Table.Th>Before</Table.Th>
            <Table.Th>After</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {changes.map((change, index) => (
            <Table.Tr key={`${change.path}:${index}`}>
              <Table.Td className={styles.mono}>
                {change.path}
                <Text size="sm" c="var(--slate)">
                  {change.operation}
                </Text>
              </Table.Td>
              <Table.Td>
                <pre tabIndex={0} aria-label={`Before ${change.path}`}>{JSON.stringify(change.before, null, 2)}</pre>
              </Table.Td>
              <Table.Td>
                <pre tabIndex={0} aria-label={`After ${change.path}`}>{JSON.stringify(change.after, null, 2)}</pre>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {changes.length === 0 && (
        <Text c="var(--slate)" p="md">
          No covered differences from the current configuration.
        </Text>
      )}
    </Table.ScrollContainer>
  );
}
function Validation({ result }) {
  if (!result)
    return (
      <Text size="sm" c="var(--slate)">
        This revision has not been validated in this view.
      </Text>
    );
  return (
    <div className={styles.validation}>
      <Group gap="xs">
        <Badge color={result.valid ? 'teal' : 'orange'} c={result.valid ? 'var(--positive)' : 'var(--ember)'} variant="light">
          {result.valid ? 'Locally valid' : 'Needs correction'}
        </Badge>
        <Text size="sm">
          {result.errors?.length || 0} errors · {result.warnings?.length || 0} caveats
        </Text>
      </Group>
      {result.errors?.map((error, index) => (
        <div key={index} className={styles.validationError}>
          <strong>{error.code.replaceAll('_', ' ')}</strong>
          <span className={styles.mono}>{error.path}</span>
        </div>
      ))}
      <Text size="sm" c="var(--slate)" mt="xs">
        Validation checks local identifiers and plan structure. It does not verify credentials,
        quota, entitlement or upstream acceptance.
      </Text>
    </div>
  );
}
export function ModelsPolicy({ automaticRouting, catalogControls, catalogTools }) {
  const workspace = useWorkspace();
  const current = useResource('/api/admin/configuration', {
    onSnapshot: workspace.observeSnapshot,
  });
  const [draft, setDraft] = useState(null),
    [document, setDocument] = useState(null),
    [validation, setValidation] = useState(null);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(null),
    [notice, setNotice] = useState(null),
    [review, setReview] = useState(null),
    [historyKey, setHistoryKey] = useState(0);
  const advanced = useLevel();
  // One stored density read for the page. Every board renders at it, and only
  // the first board of the open tab carries the switch, so the page shows one.
  const [density, setDensity] = useDensity();
  const [section, setSection] = useState('editor');
  const switchOn = (owner) => (section === owner ? setDensity : undefined);
  const [visitedSections, setVisitedSections] = useState(['editor']);
  const [discardTarget, setDiscardTarget] = useState(null);
  const [publicationUncertain, setPublicationUncertain] = useState(false);
  const [historyKind, setHistoryKind] = useState('drafts');
  const dirty =
    draft && (!draft.id || JSON.stringify(document) !== JSON.stringify(draft.version.document));
  const activeDocument = document || current.data?.document;
  const refreshHistory = () => setHistoryKey((value) => value + 1);
  async function action(task) {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await task();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  const adopt = (value) => {
    setDraft(value);
    setDocument(structuredClone(value.version.document));
    setValidation(null);
    setSection('editor');
  };
  function create() {
    action(async () => {
      const state = await policyRequest('/api/admin/configuration');
      let result;
      try {
        result = await policyRequest('/api/admin/configuration/drafts', 'POST', {
          document: state.document,
          expectedCurrent: state.currentHash,
        });
      } catch (error) {
        if (error.code !== 'invalid_document') throw error;
        adopt({
          id: null,
          revision: 0,
          baseHash: state.currentHash,
          version: { document: state.document },
        });
        setNotice({
          title: 'Recorded definition needs repair',
          message:
            'The recorded document needs repair before it can be stored. These edits are local until you save the first draft revision.',
        });
        return;
      }
      adopt(result);
      refreshHistory();
      setNotice({
        message: `Draft revision ${result.revision} stored. Effective routing is unchanged.`,
      });
    });
  }
  function load(id, discard = false) {
    if (dirty && !discard) {
      setDiscardTarget(id);
      return;
    }
    action(async () => {
      adopt(await policyRequest(`/api/admin/configuration/drafts/${id}`));
      setDiscardTarget(null);
    });
  }
  function save() {
    action(async () => {
      const result = await policyRequest(
        draft.id
          ? `/api/admin/configuration/drafts/${draft.id}`
          : '/api/admin/configuration/drafts',
        draft.id ? 'PATCH' : 'POST',
        {
          document,
          ...(draft.id
            ? { expectedRevision: draft.revision }
            : { expectedCurrent: draft.baseHash }),
        }
      );
      adopt(result);
      refreshHistory();
      setNotice({
        message: `Draft revision ${result.revision} stored. Effective routing is unchanged.`,
      });
    });
  }
  function validate() {
    action(async () => {
      const result = await policyRequest(
        `/api/admin/configuration/drafts/${draft.id}/validate`,
        'POST',
        { expectedRevision: draft.revision }
      );
      setValidation(result);
      refreshHistory();
    });
  }
  function publication(actionName, versionId) {
    if (dirty) {
      setFailure(new Error('Save the edited draft before reviewing publication.'));
      return;
    }
    action(async () => {
      const state = await policyRequest('/api/admin/configuration');
      if (actionName === 'activate') {
        const detail = await policyRequest(`/api/admin/configuration/drafts/${draft.id}`);
        if (detail.revision !== draft.revision) {
          const error = new Error(
            'The stored draft changed. Open its latest revision before activation.'
          );
          error.code = 'revision_conflict';
          throw error;
        }
        setReview({
          action: actionName,
          expectedCurrent: state.currentHash,
          revision: draft.revision,
          id: draft.id,
          diff: detail.diff,
        });
      } else {
        const version = await policyRequest(`/api/admin/configuration/versions/${versionId}`);
        setReview({
          action: actionName,
          expectedCurrent: state.currentHash,
          id: versionId,
          diff: [
            {
              path: '/covered-routing-document',
              operation: 'restore',
              before: state.document,
              after: version.document,
            },
          ],
        });
      }
    });
  }
  function publish() {
    action(async () => {
      const reviewed = review;
      setReview(null);
      setPublicationUncertain(true);
      const result = await policyRequest(
        reviewed.action === 'activate'
          ? `/api/admin/configuration/drafts/${reviewed.id}/activate`
          : `/api/admin/configuration/versions/${reviewed.id}/rollback`,
        'POST',
        {
          expectedCurrent: reviewed.expectedCurrent,
          ...(reviewed.action === 'activate' ? { expectedRevision: reviewed.revision } : {}),
        }
      );
      current.refresh();
      refreshHistory();
      setNotice({
        partial: result.outcome === 'partial',
        message:
          result.outcome === 'partial'
            ? 'Configuration committed with incomplete follow-up. Inspect the receipt before another action.'
            : `Configuration version ${result.version.id} applied. Subsequent requests use it.`,
        result,
      });
      const readback = await policyRequest('/api/admin/configuration');
      if (readback.currentHash !== result.currentHash) throw new Error('The active policy differs from the publication receipt. Inspect current state and receipts before another action.');
      if (result.outcome !== 'partial') setPublicationUncertain(false);
    });
  }
  function inspectPublication() {
    action(async () => {
      await policyRequest('/api/admin/configuration');
      await policyRequest('/api/admin/configuration/receipts?limit=20');
      current.refresh(); refreshHistory(); setHistoryKind('receipts'); setSection('history');
      setPublicationUncertain(false);
      setNotice({message:'Current policy and operation receipts read. Inspect the recorded outcome before reviewing a new activation or restoration.'});
    });
  }
  return (
    <div className={`${shared.lensPage} ${styles.root}`} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Models</h1>
          <p>
            {advanced ? 'Advanced' : 'Everyday'} · the catalog, its plans and the routing they
            resolve to
          </p>
        </div>
        <span className={styles.mono} title={current.data?.currentHash}>
          Active {shortHash(current.data?.currentHash)}
        </span>
      </div>
      <ScopeBar analysisActions={false} />
      <div className={`${shared.lensBody} ${styles.body}`}>
      {publicationUncertain && <Alert color="orange" title="Publication requires reconciliation" mt="sm">The prior publication has no verified complete readback. It will not be replayed. Inspect the current hash and operation receipts before another publication.<Button variant="subtle" disabled={busy} onClick={inspectPublication}>Inspect current policy and receipts</Button></Alert>}
      {failure && (
        <Alert
          color="red"
          title={
            failure.code?.includes('conflict')
              ? 'State changed in another view'
              : 'Operation did not complete'
          }
        >
          {failure.message}
          {failure.code && (
            <Text size="sm" className={styles.mono}>
              {failure.code}
            </Text>
          )}
          {failure.details?.receipt && (
            <Text size="sm">
              Receipt {failure.details.receipt.id} · {failure.details.receipt.outcome}
            </Text>
          )}
          <Text size="sm" mt="xs">
            Your edits are retained. Read the latest state before retrying.
          </Text>
          {draft?.id && (
            <Button variant="subtle" onClick={() => load(draft.id)}>
              Reload stored revision
            </Button>
          )}
        </Alert>
      )}
      {notice && (
        <div className={styles.notice} role="status" data-partial={notice.partial || undefined}>
          <strong>{notice.title || (notice.partial ? 'Partial completion' : 'Recorded')}</strong>
          {notice.message}
          {notice.result && (
            <div className={styles.receipt}>
              <span>
                Receipt {notice.result.receipt?.id} · {notice.result.receipt?.outcome}
              </span>
              <span className={styles.mono}>{shortHash(notice.result.currentHash)}</span>
              {notice.result.completion && (
                <pre>{JSON.stringify(notice.result.completion, null, 2)}</pre>
              )}
            </div>
          )}
        </div>
      )}
      <Tabs
        value={section}
        onChange={(value) => {
          setSection(value);
          setVisitedSections((previous) =>
            previous.includes(value) ? previous : [...previous, value]
          );
        }}
        keepMounted={false}
        className={styles.pageTabs}
      >
        <Tabs.List aria-label="Model configuration tasks">
          <Tabs.Tab value="editor">Plans</Tabs.Tab>
          <Tabs.Tab value="catalog">Catalog</Tabs.Tab>
          <Tabs.Tab value="routing">Routing</Tabs.Tab>
          <Tabs.Tab value="simulator">Route preview</Tabs.Tab>
          <Tabs.Tab value="history">History</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="editor" keepMounted>
          <div className={styles.toolbar}>
            <Group gap="xs">
              <Badge
                size="sm"
                variant="light"
                color={dirty ? 'orange' : 'teal'}
                c={dirty ? 'var(--ember)' : 'var(--positive)'}
              >
                {draft
                  ? draft.id
                    ? `Draft r${draft.revision}${dirty ? ' · unsaved edits' : ''}`
                    : 'Local repair · not stored'
                  : 'Effective configuration'}
              </Badge>
              {draft?.id && (
                <span className={styles.mono} title={draft.id}>
                  {draft.id.slice(0, 12)}
                </span>
              )}
            </Group>
            <Group gap="xs">
              <Button
                size="xs"
                variant="subtle"
                disabled={busy}
                loading={current.loading}
                onClick={current.refresh}
              >
                Refresh active policy
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={busy || dirty || !current.data}
                onClick={create}
              >
                New draft from active
              </Button>
              {draft && (
                <>
                  <Button size="xs" variant="default" disabled={busy || !dirty} onClick={save}>
                    Save draft revision
                  </Button>
                  <Button size="xs" variant="light" disabled={busy || dirty} onClick={validate}>
                    Validate locally
                  </Button>
                  <Button
                    size="xs"
                    disabled={busy || publicationUncertain || dirty || !validation?.valid}
                    onClick={() => publication('activate')}
                  >
                    Review activation
                  </Button>
                </>
              )}
            </Group>
          </div>
          {busy && <Text role="status">Reading or recording policy state…</Text>}
          {current.error && (
            <Alert color="red" title="Active configuration unavailable">
              {current.error}
              <Button size="xs" variant="subtle" onClick={current.refresh}>
                Retry active state
              </Button>
            </Alert>
          )}
          {!activeDocument && current.loading && <Text role="status">Reading active policy…</Text>}
          {activeDocument && (
            <>
              <PolicyEditor
                document={activeDocument}
                disabled={!draft || busy}
                accounts={workspace.accounts}
                density={density}
                onDensity={switchOn('editor')}
                onChange={(value) => {
                  setDocument(value);
                  setValidation(null);
                }}
              />
              <div className={styles.panelBody}>
                <Validation result={draft ? validation : current.data?.validation} />
              </div>
            </>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="catalog" keepMounted>
          {visitedSections.includes('catalog') && (
            <div className={styles.stack}>
              {cloneElement(catalogControls, { density, onDensity: switchOn('catalog') })}
              {catalogTools}
            </div>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="routing" keepMounted>
          {visitedSections.includes('routing') && (
            <div className={styles.stack}>
              {automaticRouting}
              <CascadePolicy density={density} onDensity={switchOn('routing')} />
            </div>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="simulator" keepMounted>
          <RoutingSimulator
            draft={
              draft?.id && !dirty
                ? {
                    version: 1,
                    document: draft.version.document,
                    draftId: draft.id,
                    revision: draft.revision,
                  }
                : null
            }
          />
        </Tabs.Panel>
        <Tabs.Panel value="history">
          <div className={styles.stack}>
            <PolicyHistory
              initialKind={historyKind}
              refreshKey={historyKey}
              disabled={busy || publicationUncertain}
              onLoadDraft={load}
              onRollback={(id) => publication('rollback', id)}
            />
            <ConfigurationDomains />
            <PlanTransfer
              disabled={busy || dirty}
              onImported={(value) => {
                adopt(value);
                refreshHistory();
                setNotice({
                  message: `Imported draft revision ${value.revision} stored and read back. Validate and review its differences before activation.`,
                });
              }}
            />
          </div>
        </Tabs.Panel>
      </Tabs>
      </div>
      <Modal
        opened={Boolean(review)}
        onClose={() => {
          if (!busy) setReview(null);
        }}
        title={
          review?.action === 'activate'
            ? 'Review draft activation'
            : 'Review configuration restoration'
        }
        size="xl"
        closeButtonProps={{ disabled: busy, 'aria-label': 'Close publication review' }}
      >
        {review && (
          <Stack>
            <Text size="sm">
              Only the covered fields below will change. In-flight requests retain their existing
              selection. The server rechecks the active hash and draft revision atomically.
            </Text>
            {failure && (
              <Alert color="red" title="Publication did not complete">
                {failure.message}
                <Text size="sm">
                  {failure.code}
                  {failure.details?.receipt
                    ? ` · receipt ${failure.details.receipt.id} (${failure.details.receipt.outcome})`
                    : ''}
                </Text>
              </Alert>
            )}
            <Text size="sm" className={styles.mono}>
              Expected active {review.expectedCurrent}
            </Text>
            <Differences changes={review.diff} />
            <Text size="sm" c="var(--ember)">
              A partial or interrupted operation requires receipt inspection. It is never retried
              automatically.
            </Text>
            <Group justify="end">
              <Button variant="default" disabled={busy} onClick={() => setReview(null)}>
                Cancel
              </Button>
              <Button loading={busy} onClick={publish}>
                {review.action === 'activate'
                  ? `Activate revision ${review.revision}`
                  : `Restore version ${review.id}`}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
      <Modal
        opened={Boolean(discardTarget)}
        onClose={() => {
          if (!busy) setDiscardTarget(null);
        }}
        title="Replace local draft edits?"
        size="sm"
        closeButtonProps={{ disabled: busy, 'aria-label': 'Close draft reload review' }}
      >
        <Stack>
          <Text>
            The latest stored revision will replace unsaved edits in this view. Published
            configuration and stored history are unchanged.
          </Text>
          <Group justify="end">
            <Button variant="default" disabled={busy} onClick={() => setDiscardTarget(null)}>
              Keep editing
            </Button>
            <Button loading={busy} onClick={() => load(discardTarget, true)}>
              Reload and discard local edits
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
