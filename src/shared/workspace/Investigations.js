'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ActionIcon, Alert, Button, Group, Select, Text, TextInput, Tooltip } from '@mantine/core';
import { providerIdentity } from '@/shared/components/ProviderMark';
import { Icon } from '@/shared/components/Icon';
import { useWorkspace } from './WorkspaceProvider';
import { useResource } from './useResource';
import { InlineConfirm } from './InlineConfirm';
import {
  LENS_PATHS,
  selectionExcluded,
  selectionLens,
} from '@/lib/db/analytics/investigationModel.mjs';
import { serializeEvidence } from '@/lib/db/analytics/evidenceFormat.mjs';
import styles from './investigations.module.css';

async function request(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'The operation failed.');
    error.code = result.code;
    throw error;
  }
  return result;
}
const kindName = {
  investigation: 'Investigation',
  'filter-set': 'Named filter set',
  bookmark: 'Record bookmark',
};
const lensOf = (pathname) =>
  Object.entries(LENS_PATHS).find(([, path]) => path === pathname)?.[0] || 'capacity';

// A section opened from the scope strip sits in the page flow directly under
// it. Opening moves focus into it (its marked field, else the section itself)
// so Escape and a screen reader land there, and it cannot close while it
// writes. An open list or picker inside keeps Escape for itself, as it does in
// Mantine's own layers.
export function ScopeSection({ label, closeLabel, busy = false, onClose, children }) {
  const root = useRef(null);
  useEffect(() => {
    const node = root.current;
    (node.querySelector('[data-autofocus]') || node).focus({ preventScroll: true });
  }, []);
  const escape = (event) => {
    if (event.key !== 'Escape' || busy || event.nativeEvent.isComposing) return;
    if (event.target.getAttribute?.('data-mantine-stop-propagation') === 'true') return;
    event.stopPropagation();
    onClose();
  };
  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label={label}
      className={styles.section}
      onKeyDown={escape}
    >
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{label}</h2>
        <Tooltip label={closeLabel}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={closeLabel}
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="i-close" />
          </ActionIcon>
        </Tooltip>
      </div>
      {children}
    </section>
  );
}

// What the retained selection is, read the same way by its summary control,
// its details and the evidence export.
function useRetainedSelection() {
  const workspace = useWorkspace(),
    pathname = usePathname();
  const selected = workspace.selectedRecord;
  const account =
    selected?.kind === 'account'
      ? workspace.accounts.find((row) => row.connectionId === selected.id)
      : null;
  const label = account
    ? `${account.displayName || account.provider} · ${providerIdentity(account.provider).name}`
    : selected?.kind === 'economics-group'
      ? `${selected.groupBy} cohort · ${selected.model || selected.connectionId || selected.provider || 'Unspecified'}`
      : selected
        ? `${selected.kind.replaceAll('-', ' ')} · ${selected.id.length > 28 ? selected.id.slice(0, 24) + '…' : selected.id}`
        : '';
  return {
    workspace,
    pathname,
    selected,
    label,
    lens: lensOf(pathname),
    comparisons: workspace.comparisonIds.length,
    excluded: selected && selectionExcluded(selected, workspace.scope),
    recordPath: selected ? LENS_PATHS[selectionLens(selected)] : null,
    canExportPopulation: pathname !== LENS_PATHS.capacity,
    canCompareAttempts:
      pathname === LENS_PATHS.context &&
      selected?.kind === 'context-attempt' &&
      workspace.contextView.baseline &&
      workspace.contextView.baseline.id !== selected.id,
  };
}

export function SavedInvestigations({ busy, setBusy, onClose }) {
  const workspace = useWorkspace(),
    router = useRouter(),
    pathname = usePathname();
  const lens = lensOf(pathname);
  const [name, setName] = useState(workspace.savedEntry?.name || ''),
    [kind, setKind] = useState(workspace.savedEntry?.kind || 'investigation');
  const [failure, setFailure] = useState(null),
    [notice, setNotice] = useState(null),
    [deleting, setDeleting] = useState(null);
  const entries = useResource('/api/admin/investigations');
  async function save(update = false) {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const current = workspace.savedEntry;
      const body = {
        name,
        kind,
        definition: workspace.captureDefinition(lens),
        ...(update ? { version: current.version } : {}),
      };
      const result = await request(
        `/api/admin/investigations${update ? `/${current.id}` : ''}`,
        update ? 'PUT' : 'POST',
        body
      );
      workspace.setSavedEntry(result);
      entries.refresh();
      setNotice(`${kindName[kind]} saved as version ${result.version}.`);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  function restore(entry) {
    workspace.restoreInvestigation(entry);
    onClose();
    if (entry.kind !== 'filter-set') router.push(LENS_PATHS[entry.definition.lens]);
  }
  async function remove() {
    setBusy(true);
    setFailure(null);
    try {
      await request(`/api/admin/investigations/${deleting.id}`, 'DELETE', {
        version: deleting.version,
      });
      if (workspace.savedEntry?.id === deleting.id) workspace.setSavedEntry(null);
      setDeleting(null);
      entries.refresh();
      setNotice('Saved entry deleted.');
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  async function reloadVersion() {
    setBusy(true);
    setFailure(null);
    try {
      const target = deleting || workspace.savedEntry;
      if (!target) throw new Error('Choose a stored entry before reloading its version.');
      const response = await fetch(`/api/admin/investigations/${target.id}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      if (deleting) setDeleting(body);
      else {
        workspace.setSavedEntry(body);
        setName(body.name);
        setKind(body.kind);
      }
      entries.refresh();
      setNotice(
        'Latest saved version loaded. Current filters and selected evidence are unchanged.'
      );
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  const conflict = failure?.code === 'version_conflict';
  return (
    <ScopeSection
      label="Saved investigations"
      closeLabel="Close saved investigations"
      busy={busy}
      onClose={onClose}
    >
      <Text size="xs" c="var(--slate)">
        Shared by this installation’s authenticated operators. Saved ranges use fixed UTC
        boundaries. No request content or credentials are stored.
      </Text>
      {failure && (
        <Alert
          color="red"
          p="xs"
          title={conflict ? 'Another view changed this entry' : 'Save operation failed'}
        >
          {failure.message}
          {conflict && (
            <Button size="xs" variant="subtle" onClick={reloadVersion} disabled={busy}>
              Reload saved version
            </Button>
          )}
        </Alert>
      )}
      {notice && (
        <Text role="status" size="xs" c="var(--slate)" className={styles.notice}>
          {notice}
        </Text>
      )}
      {deleting ? (
        <InlineConfirm
          title={`Delete “${deleting.name}”?`}
          changes="The stored definition will be removed; evidence records are untouched."
          verb="Delete saved entry"
          dismiss="Cancel deletion"
          danger
          busy={busy}
          onConfirm={remove}
          onCancel={() => {
            setDeleting(null);
            setFailure(null);
          }}
        />
      ) : (
        <form
          className={styles.saveForm}
          onSubmit={(event) => {
            event.preventDefault();
            save(false);
          }}
        >
          <TextInput
            data-autofocus
            size="xs"
            className={styles.nameField}
            label="Name"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
            disabled={busy}
          />
          <Select
            size="xs"
            className={styles.kindField}
            label="Save as"
            value={kind}
            onChange={setKind}
            allowDeselect={false}
            data={Object.entries(kindName).map(([value, label]) => ({ value, label }))}
          />
          <Button
            size="xs"
            type="submit"
            loading={busy}
            disabled={!name.trim() || (kind === 'bookmark' && !workspace.selectedRecord)}
          >
            Save new entry
          </Button>
          {workspace.savedEntry && (
            <Button
              size="xs"
              variant="default"
              disabled={busy || !name.trim()}
              onClick={() => save(true)}
            >
              Update version {workspace.savedEntry.version}
            </Button>
          )}
          <Text size="xs" c="var(--slate)" className={styles.formNote}>
            {kind === 'filter-set'
              ? 'Filters only. Restoring this set retains your selected evidence.'
              : kind === 'bookmark'
                ? 'The exact selected identity, its fixed scope and comparison accounts.'
                : 'Current lens, filters, selected identity, account comparison and lens controls.'}
          </Text>
        </form>
      )}
      <section aria-label="Stored investigations" className={styles.entries}>
        <h3>Stored definitions</h3>
        {entries.loading && (
          <Text size="xs" role="status">
            Reading saved entries…
          </Text>
        )}
        {entries.error && (
          <Alert color="red" p="xs">
            {entries.error}
            <Button size="xs" variant="subtle" onClick={entries.refresh}>
              Retry saved entries
            </Button>
          </Alert>
        )}
        {!entries.loading && entries.data?.items?.length === 0 && (
          <Text size="xs" c="var(--slate)">
            No saved definitions yet.
          </Text>
        )}
        {entries.data?.items?.map((entry) => (
          <div key={entry.id} className={styles.entry}>
            <div>
              <strong>{entry.name}</strong>
              <Text size="xs" c="var(--slate)">
                {kindName[entry.kind]} · {entry.definition.lens} · version {entry.version}
              </Text>
            </div>
            <Group gap="xs">
              <Button
                size="compact-xs"
                variant="light"
                aria-label={`Restore ${entry.name}`}
                onClick={() => restore(entry)}
              >
                Restore
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                aria-label={`Delete ${entry.name}`}
                onClick={() => {
                  setDeleting(entry);
                  setFailure(null);
                }}
              >
                Delete
              </Button>
            </Group>
          </div>
        ))}
      </section>
    </ScopeSection>
  );
}

// The summary of what stays selected and the export action share one group on
// the strip. Their details and the export open as sections under it.
export function SelectionEvidence({ section, onToggle }) {
  const { selected, label, comparisons, excluded } = useRetainedSelection();
  const open = section === 'selection';
  return (
    <div className={styles.selectionBar} role="group" aria-label="Retained evidence selection">
      {(selected || comparisons > 0) && (
        <Button
          data-scope-trigger="selection"
          variant="light"
          className={styles.selectionTrigger}
          color={excluded ? 'orange' : undefined}
          onClick={() => onToggle('selection')}
          aria-label="Selected evidence"
          aria-expanded={open}
          rightSection={<Icon name={open ? 'i-chevron-up' : 'i-chevron-down'} />}
        >
          <span className={styles.selectionLabel}>
            {excluded ? 'Outside scope' : selected ? 'Selected' : 'Comparison'}
            {selected ? ` · ${label}` : ` · ${comparisons} accounts`}
          </span>
        </Button>
      )}
      <Button
        data-scope-trigger="export"
        variant="subtle"
        aria-expanded={section === 'export'}
        onClick={() => onToggle('export')}
      >
        Export evidence
      </Button>
    </div>
  );
}

export function SelectionDetails({ onClose }) {
  const router = useRouter();
  const { workspace, pathname, selected, label, comparisons, excluded, recordPath } =
    useRetainedSelection();
  return (
    <ScopeSection
      label="Retained evidence details"
      closeLabel="Close retained evidence details"
      onClose={onClose}
    >
      <div className={styles.selectionDetails}>
        {selected && (
          <>
            <div className={styles.selectionIdentity}>
              <Text fw={600} size="xs">
                {label}
              </Text>
              <Text size="xs" c="dimmed" className={styles.record}>
                {selected.kind} · {selected.id}
              </Text>
            </div>
            <Text size="xs">
              {excluded
                ? 'This record is outside the current filters. Its exact evidence stays selected.'
                : 'This exact record stays selected when you move between views.'}
            </Text>
          </>
        )}
        {comparisons > 0 && <Text size="xs">{comparisons} accounts retained for comparison.</Text>}
        <Group gap="xs">
          {selected && recordPath !== pathname && (
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                onClose();
                router.push(recordPath);
              }}
            >
              Open record lens
            </Button>
          )}
          {selected && (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              onClick={() => {
                workspace.setSelectedRecord(null);
                onClose();
              }}
            >
              Clear selection
            </Button>
          )}
          {comparisons > 0 && (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              onClick={() => {
                workspace.setComparisonIds([]);
                onClose();
              }}
            >
              Clear comparison
            </Button>
          )}
        </Group>
      </div>
    </ScopeSection>
  );
}

export function EvidenceExport({ busy, setBusy, onClose }) {
  const { workspace, selected, comparisons, lens, canExportPopulation, canCompareAttempts } =
    useRetainedSelection();
  const [mode, setMode] = useState(
    selected ? 'selected' : comparisons ? 'comparison' : canExportPopulation ? 'population' : null
  );
  const [error, setError] = useState(null),
    [manifest, setManifest] = useState(null);
  async function download() {
    setBusy(true);
    setError(null);
    setManifest(null);
    try {
      const result = await request('/api/admin/investigations/export', 'POST', {
        mode,
        definition: workspace.captureDefinition(lens),
      });
      if (workspace.snapshot)
        result.manifest.preview = {
          ...workspace.snapshot,
          basis:
            'Authenticated response headers observed by this workspace; freshness describes the database read transaction.',
        };
      const blob = new Blob([serializeEvidence(result, true)], { type: 'application/json' }),
        url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `tokenproxy-evidence-${lens}-${new Date().toISOString().replaceAll(':', '-')}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setManifest(result.manifest);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScopeSection
      label="Export recorded evidence"
      closeLabel="Close evidence export"
      busy={busy}
      onClose={onClose}
    >
      <div className={styles.exportRow}>
        <Select
          size="xs"
          className={styles.exportScope}
          label="Evidence scope"
          value={mode}
          onChange={setMode}
          allowDeselect={false}
          data={[
            {
              value: 'selected',
              label:
                selected?.kind === 'economics-group'
                  ? 'Selected cohort in shared scope'
                  : 'Exact selected record',
              disabled: !selected,
            },
            {
              value: 'population',
              label: `Complete filtered ${lens} population`,
              disabled: !canExportPopulation,
            },
            { value: 'comparison', label: 'Selected comparison accounts', disabled: !comparisons },
            {
              value: 'attempt-comparison',
              label: 'Exact selected attempt and baseline',
              disabled: !canCompareAttempts,
            },
          ]}
        />
        <Button size="xs" loading={busy} disabled={!mode} onClick={download}>
          Download JSON evidence
        </Button>
      </div>
      {!canExportPopulation && (
        <Text size="xs" c="var(--slate)">
          Capacity exports the chosen account or comparison accounts. Select an account before
          exporting its current persisted quota evidence.
        </Text>
      )}
      <Text size="xs">
        Exports use one committed read snapshot. Exact record identities ignore current filters.
        Selected cohorts and population exports apply the fixed shared scope and recorded lens
        filters. Maximum 5,000 records and 8 MiB; larger exports are refused without a partial file.
      </Text>
      <Text size="xs" c="var(--slate)">
        The file includes source, UTC boundaries, coverage, completeness and measurement caveats. It
        excludes credentials, request bodies, raw client identifiers and private session affinity
        hashes. Context exports retain the labeled opaque references and structural fingerprints.
      </Text>
      {error && (
        <Alert color="red" p="xs" title="Export not produced">
          {error}
        </Alert>
      )}
      {manifest && (
        <Alert color="teal" p="xs" title="Evidence exported">
          {manifest.returnedRecords} of {manifest.totalRecords} matching records.{' '}
          {manifest.comparisonComplete === false
            ? `${manifest.missingAttempts.length} requested attempt identity is no longer retained; the comparison is incomplete.`
            : manifest.missingSelection
              ? 'The exact selected identity was not retained.'
              : 'Complete export.'}
        </Alert>
      )}
    </ScopeSection>
  );
}
