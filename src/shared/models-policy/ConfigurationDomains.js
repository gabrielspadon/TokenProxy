'use client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, Select, Stack, Table, Text } from '@mantine/core';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { policyRequest, shortHash, utcTime } from './policyModel';
import styles from './policy.module.css';

const base = '/api/admin/configuration-domains';
const storageKey = 'tokenproxy.configuration-domains.v1';
const domains = [
  { value: 'all', label: 'All covered domains' },
  { value: 'accounts', label: 'Account policy' },
  { value: 'providerPolicy', label: 'Provider policy' },
  { value: 'disabledModels', label: 'Disabled models' },
  { value: 'saver', label: 'Token savers' },
  { value: 'network', label: 'Network and proxy policy' },
];
const valueText = (value) => JSON.stringify(value);

export function ConfigurationDomains() {
  const { scope } = useWorkspace();
  const [current, setCurrent] = useState(null),
    [versions, setVersions] = useState([]),
    [drafts, setDrafts] = useState([]),
    [receipts, setReceipts] = useState([]);
  const [comparison, setComparison] = useState(null),
    [draft, setDraft] = useState(null),
    [validation, setValidation] = useState(null),
    [selected, setSelected] = useState([]);
  const [domain, setDomain] = useState('all'),
    [inspect, setInspect] = useState(false),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [notice, setNotice] = useState(null),
    [uncertain, setUncertain] = useState(false);
  async function refresh() {
    const [active, history, stored, audit] = await Promise.all([
      policyRequest(base),
      policyRequest(`${base}/versions?limit=100`),
      policyRequest(`${base}/drafts?limit=100`),
      policyRequest(`${base}/receipts?limit=20`),
    ]);
    setCurrent(active);
    setVersions(history.versions);
    setDrafts(stored.drafts);
    setReceipts(audit.receipts);
  }
  async function action(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (failure) {
      setError({ code: failure.code, message: failure.message, details: failure.details });
      if (failure.code === 'mutation_uncertain') {
        setUncertain(true);
        localStorage.setItem(storageKey, JSON.stringify({ draftId: draft?.id, uncertain: true }));
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    queueMicrotask(async () => {
      if (!active) return;
      await action(async () => {
        await refresh();
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (saved?.uncertain) setUncertain(true);
        if (saved?.draftId)
          setDraft(await policyRequest(`${base}/drafts/${encodeURIComponent(saved.draftId)}`));
      });
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only initial load. action is redeclared every render, so listing it would re-run this fetch on every render; its own dependencies are the stable state setters.
  }, []);
  const retainDraft = (value) => {
    setDraft(value);
    setComparison(null);
    setValidation(null);
    setConsent(false);
    setSelected([]);
    localStorage.setItem(storageKey, JSON.stringify({ draftId: value.id }));
  };
  const changes = draft?.diff || comparison?.diff || [];
  const visible = changes.filter(
    (change) =>
      (domain === 'all' || change.path.startsWith(`/${domain}/`)) &&
      (!scope.connectionId ||
        !change.path.startsWith('/accounts/') ||
        change.path.startsWith(
          `/accounts/${scope.connectionId.replaceAll('~', '~0').replaceAll('/', '~1')}/`
        ))
  );
  const create = () =>
    action(async () => {
      retainDraft(
        await policyRequest(`${base}/drafts`, 'POST', {
          document: current.document,
          expectedCurrent: current.currentHash,
        })
      );
      await refresh();
      setNotice('Current configuration retained as an immutable snapshot and draft.');
    });
  const compare = (id) =>
    action(async () => {
      setComparison(await policyRequest(`${base}/versions/${id}/compare`));
      setDraft(null);
      setSelected([]);
      setValidation(null);
      setConsent(false);
      localStorage.removeItem(storageKey);
    });
  const stage = () =>
    action(async () => {
      retainDraft(
        await policyRequest(`${base}/versions/${comparison.version.id}/restore`, 'POST', {
          expectedCurrent: comparison.currentHash,
          paths: selected,
        })
      );
      await refresh();
      setNotice('Selected restoration retained as a draft. Effective configuration is unchanged.');
    });
  const validate = () =>
    action(async () => {
      const result = await policyRequest(`${base}/drafts/${draft.id}/validate`, 'POST', {
        expectedRevision: draft.revision,
      });
      setValidation(result);
      setConsent(false);
    });
  const activate = () =>
    action(async () => {
      const result = await policyRequest(`${base}/drafts/${draft.id}/activate`, 'POST', {
        expectedCurrent: validation.currentHash,
        expectedRevision: draft.revision,
        consent: consent ? validation.requiredConsent : [],
      });
      setNotice(result);
      setUncertain(result.outcome === 'partial');
      setDraft(null);
      setValidation(null);
      if (result.outcome === 'partial')
        localStorage.setItem(
          storageKey,
          JSON.stringify({ uncertain: true, operationId: result.receipt.operationId })
        );
      else localStorage.removeItem(storageKey);
      await refresh();
    });
  return (
    <Stack gap="md" className={styles.panelBody}>
      <Group justify="space-between" align="start">
        <div>
          <Text fw={600}>Configuration versions</Text>
          <Text size="sm" c="dimmed">
            Restore selected policy fields using retained versions and exact before/after values.
          </Text>
        </div>
        <Group gap="xs">
          <Button
            variant="default"
            disabled={busy}
            onClick={() =>
              action(async () => {
                await refresh();
                if (draft) setDraft(await policyRequest(`${base}/drafts/${draft.id}`));
                setValidation(null);
              })
            }
          >
            Refresh configuration
          </Button>
          <Button variant="light" disabled={busy || !current || uncertain} onClick={create}>
            Retain current draft
          </Button>
          <Button variant="subtle" onClick={() => setInspect(true)}>
            Inspect coverage and receipts
          </Button>
        </Group>
      </Group>
      {busy && <Text role="status">Reading or recording configuration…</Text>}
      {error && (
        <Alert color="red" title="Configuration operation refused" role="alert">
          <Text>
            {error.code} · {error.message}
          </Text>
          <Text size="sm">Refresh and review the retained draft before trying again.</Text>
        </Alert>
      )}
      {notice && (
        <Alert
          color={typeof notice === 'object' && notice.outcome === 'partial' ? 'orange' : 'teal'}
          title={
            typeof notice === 'object' ? `Activation ${notice.outcome}` : 'Configuration retained'
          }
        >
          <Text size="sm">
            {typeof notice === 'string'
              ? notice
              : `Version ${notice.version.id} · receipt ${notice.receipt.id} · ${notice.receipt.details.runtimeRefresh || notice.completion?.runtimeRefresh}`}
          </Text>
          {typeof notice === 'object' && notice.completion && (
            <pre>{JSON.stringify(notice.completion, null, 2)}</pre>
          )}
        </Alert>
      )}
      {uncertain && (
        <Alert color="orange">
          Publication completion is uncertain. Read the receipts and resolve persistence or runtime
          refresh before another mutation. No automatic replay is available.
        </Alert>
      )}
      {current && (
        <Group gap="md">
          <Badge variant="light">
            {current.versionId
              ? `Current version ${current.versionId}`
              : 'Current state not yet retained'}
          </Badge>
          <Text size="sm" title={current.currentHash}>
            {shortHash(current.currentHash)}
          </Text>
          <Text size="sm">
            {Object.keys(current.document.accounts).length} accounts ·{' '}
            {Object.keys(current.document.network.pools).length} proxy pools
          </Text>
          <Text size="sm">
            {scope.connectionId ? `Account filter ${scope.connectionId}` : 'Shared workspace scope'}
          </Text>
        </Group>
      )}
      <Group grow align="start">
        <Select
          label="Retained version to compare"
          placeholder="Choose a published snapshot"
          data={versions
            .filter((row) => row.kind !== 'draft')
            .map((row) => ({
              value: String(row.id),
              label: `v${row.id} · ${row.kind} · ${utcTime(row.createdAt)}`,
            }))}
          value={comparison ? String(comparison.version.id) : null}
          onChange={(id) => id && compare(id)}
          disabled={busy}
          searchable
        />
        <Select
          label="Stored configuration draft"
          placeholder="Open a retained revision"
          data={drafts.map((row) => ({
            value: row.id,
            label: `${row.id.slice(0, 10)} · r${row.revision} · ${utcTime(row.updatedAt)}`,
          }))}
          value={draft?.id || null}
          onChange={(id) =>
            id && action(async () => retainDraft(await policyRequest(`${base}/drafts/${id}`)))
          }
          disabled={busy}
          searchable
        />
        <Select label="Visible domain" data={domains} value={domain} onChange={setDomain} />
      </Group>
      <SelectionDock
        open={inspect}
        onClose={() => setInspect(false)}
        title="Configuration evidence"
        subtitle="Retained coverage and operation receipts"
        minimumComparisonWidth={620}
        detail={
          <Stack gap="sm" p="md">
            <Text fw={600}>Coverage</Text>
            {current?.coverage.included.map((text) => (
              <Text key={text} size="sm">
                {text}
              </Text>
            ))}
            <Text fw={600}>Preserved outside restoration</Text>
            {current?.coverage.excluded.map((text) => (
              <Text key={text} size="sm">
                {text}
              </Text>
            ))}
            <Text size="sm">{current?.coverage.redaction}</Text>
            <Text size="sm">{current?.coverage.takesEffect}</Text>
            <Text fw={600}>Recent operation receipts</Text>
            {receipts.map((row) => (
              <div key={row.id}>
                <Text size="sm">
                  {row.id} · {row.action} · {row.outcome}
                </Text>
                <Text size="xs">
                  {row.details.code || row.details.runtimeRefresh || row.details.effect}
                </Text>
              </div>
            ))}
            <pre
              tabIndex={0}
              style={{ overflowX: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {JSON.stringify(
                {
                  references: current?.references,
                  draft: draft?.id,
                  version: comparison?.version.id,
                  receipt: typeof notice === 'object' ? notice?.receipt : null,
                },
                null,
                2
              )}
            </pre>
          </Stack>
        }
      >
        <Table.ScrollContainer
          minWidth={660}
          scrollAreaProps={{
            viewportProps: {
              tabIndex: 0,
              role: 'region',
              'aria-label': 'Scroll selective configuration changes',
            },
          }}
        >
          <Table striped aria-label="Selective configuration changes">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Restore</Table.Th>
                <Table.Th>Covered field</Table.Th>
                <Table.Th>Current value</Table.Th>
                <Table.Th>Retained value</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visible.map((change) => (
                <Table.Tr key={change.path}>
                  <Table.Td>
                    {draft ? (
                      <Badge variant="light">Draft</Badge>
                    ) : (
                      <Checkbox
                        aria-label={`Restore ${change.path}`}
                        checked={selected.includes(change.path)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setSelected((previous) =>
                            checked
                              ? [...previous, change.path]
                              : previous.filter((path) => path !== change.path)
                          );
                        }}
                      />
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" className={styles.mono}>
                      {change.path}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {change.operation}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <pre
                      tabIndex={0}
                      style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: 340 }}
                    >
                      {valueText(change.before)}
                    </pre>
                  </Table.Td>
                  <Table.Td>
                    <pre
                      tabIndex={0}
                      style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: 340 }}
                    >
                      {valueText(change.after)}
                    </pre>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {visible.length === 0 && (
          <Text p="md" c="dimmed">
            {comparison || draft
              ? 'No differences in the visible scope.'
              : 'Choose a retained version to review exact differences, or retain the current configuration.'}
          </Text>
        )}
      </SelectionDock>
      <Group justify="space-between">
        <Text size="sm">
          {selected.length} selected fields · {changes.length} total differences
          {draft && ` · retained r${draft.revision}`}
        </Text>
        <Group gap="xs">
          {comparison && (
            <Button disabled={busy || uncertain || selected.length === 0} onClick={stage}>
              Create selective restoration draft
            </Button>
          )}
          {draft && (
            <>
              <Button variant="light" disabled={busy || uncertain} onClick={validate}>
                Validate configuration draft
              </Button>
              <Button
                disabled={
                  busy ||
                  uncertain ||
                  !validation?.valid ||
                  validation.baseChanged ||
                  validation.revision !== draft.revision ||
                  (changes.some((change) => change.path.startsWith('/saver/')) &&
                    validation.requiredConsent?.length > 0 &&
                    !consent)
                }
                onClick={activate}
              >
                Activate reviewed configuration
              </Button>
            </>
          )}
        </Group>
      </Group>
      {validation?.baseChanged && (
        <Alert color="orange" title="Draft base changed">
          This draft includes a previously reviewed configuration. Choose the retained source
          version again and create a new selective draft against the current values.
        </Alert>
      )}
      {validation && (
        <Alert
          color={validation.valid ? 'teal' : 'orange'}
          title={validation.valid ? 'Draft is locally valid' : 'Draft needs correction'}
        >
          <Text size="sm">
            {validation.errors.map((item) => `${item.code} ${item.path || ''}`).join(' · ') ||
              `Validated r${validation.revision} against ${shortHash(validation.currentHash)}. No upstream calls.`}
          </Text>
          {changes.some((change) => change.path.startsWith('/saver/')) &&
            validation.requiredConsent?.length > 0 && (
              <Checkbox
                mt="sm"
                label={`Acknowledge content-changing saver controls (${validation.requiredConsent.join(', ')})`}
                checked={consent}
                onChange={(event) => setConsent(event.currentTarget.checked)}
              />
            )}
        </Alert>
      )}
      <Text size="sm" c="dimmed">
        Credentials and endpoint URLs remain current. Missing account or proxy references are
        refused. Changes apply at subsequent request boundaries; this does not restore software or
        the database.
      </Text>
    </Stack>
  );
}
