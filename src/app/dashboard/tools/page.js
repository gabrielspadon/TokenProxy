'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ActionIcon, Button, CopyButton, Text, TextInput, Tooltip } from '@mantine/core';
import { usePoll } from '@/shared/hooks/usePoll';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { refusal } from '@/shared/refusal';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  Card,
  DensitySwitch,
  EvidenceLine,
  StateWord,
  boardStyles,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';
import { LOCAL_STDIO_PLUGINS } from '@/shared/constants/coworkPlugins';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './tools.module.css';

// Every extension lands in exactly one bucket; the order here is the order the
// strip and the groups render.
const BUCKETS = [
  { id: 'running', label: 'Running', tone: 'positive' },
  { id: 'stopped', label: 'Stopped', tone: 'slate' },
  { id: 'unknown', label: 'Unknown', tone: 'slate' },
];
const TONE = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, bucket.tone]));
const bucketOf = (preset) =>
  preset.running === true ? 'running' : preset.running === false ? 'stopped' : 'unknown';
const wordOf = (preset) =>
  preset.running === true ? 'Running' : preset.running === false ? 'Stopped' : 'Unknown';
const count = (value) => (Number.isFinite(value) ? String(value) : 'Unknown');

// A value an operator has to paste into a client, beside the one control that
// moves it: an xs read-only field and a copy button. No dialog, no reveal.
function CopyValue({ label, value }) {
  return (
    <div className={styles.copy}>
      <span>{label}</span>
      <TextInput
        size="xs"
        readOnly
        aria-label={label}
        value={value}
        onFocus={(event) => event.currentTarget.select()}
      />
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}>
            <ActionIcon variant="default" aria-label={`Copy ${label.toLowerCase()}`} onClick={copy}>
              <Icon name={copied ? 'i-check' : 'i-copy'} />
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </div>
  );
}

function ExtensionDetail({ preset, setup }) {
  return (
    <div className={boardStyles.tabPanel}>
      {setup ? (
        <>
          <Text size="xs">
            {setup.description}. Each attached client owns its extension process. Browser MCP
            permits one simultaneous client; other presets share the gateway&apos;s 16-session
            ceiling.
          </Text>
          <Text size="xs" mt={6}>
            The gateway launches{' '}
            <code>
              {setup.command} {setup.args.join(' ')}
            </code>{' '}
            only when a client attaches. Package resolution may download software. This screen does
            not install or execute it.
          </Text>
          <Text size="xs" mt={6}>
            Configure an SSE MCP server at this gateway&apos;s origin plus this endpoint. Supply the
            machine CLI credential in <code>x-tp-cli-token</code>; an inference API key does not
            authorize this bridge. Keep that credential in your client&apos;s private environment or
            secret store.
          </Text>
          {setup.extensionUrl || setup.setupUrl ? (
            <div className={styles.links}>
              {setup.extensionUrl ? (
                <a href={setup.extensionUrl} target="_blank" rel="noopener noreferrer">
                  Install the browser extension
                </a>
              ) : null}
              {setup.setupUrl ? (
                <a href={setup.setupUrl} target="_blank" rel="noopener noreferrer">
                  {setup.setupLabel || 'Installation prerequisites'}
                </a>
              ) : null}
            </div>
          ) : null}
          <ul className={styles.toolNames} aria-label={`Declared tools of ${preset.name}`}>
            {setup.toolNames.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Text size="xs" c="dimmed" mt={6}>
        Process state does not establish package installation, tool execution or upstream readiness.
        No start, installation or test is performed by inspection. A client attaching to the bridge
        can start its extension.
      </Text>
    </div>
  );
}

function ExtensionCard({ preset, expanded, onToggle }) {
  const setup = LOCAL_STDIO_PLUGINS.find((item) => item.name === preset.id);
  const bucket = bucketOf(preset);
  return (
    <Card
      id={preset.id}
      bucket={bucket}
      expanded={expanded}
      label={preset.name}
      head={
        <>
          <span className="provider-mark" aria-hidden="true">
            <Icon name="i-tools" />
          </span>
          <div className={boardStyles.identityText}>
            <span className={boardStyles.nameLine}>
              <button
                type="button"
                className={boardStyles.nameButton}
                aria-expanded={expanded}
                onClick={onToggle}
              >
                {preset.name}
              </button>
            </span>
            <small>{preset.transport ?? 'Unknown transport'}</small>
          </div>
          <Tooltip label={expanded ? 'Collapse' : 'Details'}>
            <button
              type="button"
              className={boardStyles.caret}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${preset.name}`}
              onClick={onToggle}
            >
              <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
            </button>
          </Tooltip>
        </>
      }
      state={
        <>
          <StateWord tone={TONE[bucket]}>{wordOf(preset)}</StateWord>
          <span className={boardStyles.spacer} />
          <span className={boardStyles.cardAttempts}>{count(preset.clients)} clients</span>
        </>
      }
      detail={<ExtensionDetail preset={preset} setup={setup} />}
    >
      <EvidenceLine
        meter={false}
        label="Tools"
        value={count(preset.declaredToolCount)}
        note="not probed"
      />
      <EvidenceLine
        meter={false}
        label="Clients"
        value={count(preset.clients)}
        note={preset.transport ?? ''}
      />
      {preset.endpoint ? <CopyValue label="Bridge endpoint" value={preset.endpoint} /> : null}
    </Card>
  );
}

function ExtensionRow({ preset, expanded, onToggle }) {
  const setup = LOCAL_STDIO_PLUGINS.find((item) => item.name === preset.id);
  const bucket = bucketOf(preset);
  return (
    <article
      className={boardStyles.row}
      data-account-id={preset.id}
      data-expanded={expanded || undefined}
      data-bucket={bucket}
      aria-label={preset.name}
    >
      <div className={boardStyles.main}>
        <Tooltip label={expanded ? 'Collapse' : 'Details'}>
          <button
            type="button"
            className={boardStyles.caret}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${preset.name}`}
            onClick={onToggle}
          >
            <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
          </button>
        </Tooltip>
        <div className={boardStyles.identity}>
          <span className="provider-mark" aria-hidden="true">
            <Icon name="i-tools" />
          </span>
          <div className={boardStyles.identityText}>
            <span className={boardStyles.nameLine}>
              <button
                type="button"
                className={boardStyles.nameButton}
                aria-expanded={expanded}
                onClick={onToggle}
              >
                {preset.name}
              </button>
            </span>
            <small>{preset.transport ?? 'Unknown transport'}</small>
          </div>
        </div>
        <div className={boardStyles.state}>
          <StateWord tone={TONE[bucket]}>{wordOf(preset)}</StateWord>
        </div>
        <div className={boardStyles.quota}>
          <EvidenceLine
            meter={false}
            label="Tools"
            value={count(preset.declaredToolCount)}
            note="not probed"
          />
          {preset.endpoint ? <CopyValue label="Endpoint" value={preset.endpoint} /> : null}
        </div>
        <div className={boardStyles.activity}>
          <span>{count(preset.clients)} clients</span>
          <small>{preset.transport ?? 'Unknown transport'}</small>
        </div>
        <div className={boardStyles.actions} />
      </div>
      {expanded ? (
        <div className={boardStyles.detail} role="region" aria-label="Selection details">
          <ExtensionDetail preset={preset} setup={setup} />
        </div>
      ) : null}
    </article>
  );
}

export default function ToolsPage() {
  const tools = usePoll('/api/tools', 15000);
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const data = tools.data;
  const presets = data?.presets || [];
  const needle = query.trim().toLowerCase();
  const visible = presets.filter(
    (preset) =>
      (!bucket || bucketOf(preset) === bucket) &&
      (!needle ||
        `${preset.name} ${preset.id} ${preset.transport || ''}`.toLowerCase().includes(needle))
  );
  const summary = Object.fromEntries(
    BUCKETS.map((item) => [
      item.id,
      presets.filter((preset) => bucketOf(preset) === item.id).length,
    ])
  );
  const clients = presets.reduce((total, preset) => total + (preset.clients || 0), 0);
  const toggle = (id) => setExpandedId((current) => (current === id ? null : id));

  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Tools</h1>
          <p>
            {advanced ? 'Advanced' : 'Everyday'} · the local extensions connected to your gateway
          </p>
        </div>
      </div>
      <div className={shared.lensBody}>
        <div className={styles.stack}>
      {tools.error ? <Notice {...refusal(tools.status, tools.error)} /> : null}
      <Board label="Local extension bridge" advanced={advanced} density={density} compare="none">
        <BoardSummary
          label="Observed extension summary"
          active={bucket}
          onPick={setBucket}
          note={`${clients} attached ${clients === 1 ? 'client' : 'clients'}`}
          chips={[
            { count: presets.length, label: 'presets' },
            ...BUCKETS.map((item) => ({
              id: item.id,
              tone: item.tone,
              count: summary[item.id],
              label: item.label.toLowerCase(),
            })),
          ]}
        />
        <BoardToolbar
          search={query}
          onSearch={setQuery}
          searchLabel="Search extensions"
          actions={
            <Tooltip label="Re-read the observed process state. No extension is started.">
              <ActionIcon
                variant="default"
                aria-label="Refresh"
                loading={tools.loading && Boolean(data)}
                onClick={tools.refresh}
              >
                <Icon name="i-refresh" />
              </ActionIcon>
            </Tooltip>
          }
        >
          <Tooltip label="How much room each extension takes">
            <DensitySwitch value={density} onChange={setDensity} />
          </Tooltip>
        </BoardToolbar>
        {!advanced
          ? BUCKETS.map((item) => {
              const members = visible.filter((preset) => bucketOf(preset) === item.id);
              if (!members.length) return null;
              return (
                <BoardGroup
                  key={item.id}
                  label={item.label}
                  tone={item.tone}
                  count={members.length}
                >
                  {members.map((preset) => (
                    <ExtensionCard
                      key={preset.id}
                      preset={preset}
                      expanded={expandedId === preset.id}
                      onToggle={() => toggle(preset.id)}
                    />
                  ))}
                </BoardGroup>
              );
            })
          : null}
        {advanced ? (
          <>
            <div className={boardStyles.head} aria-hidden="true">
              <span />
              <span>Extension</span>
              <span>Process</span>
              <span>Evidence</span>
              <span>Clients</span>
              <span />
            </div>
            <div className={boardStyles.rows}>
              {visible.map((preset) => (
                <ExtensionRow
                  key={preset.id}
                  preset={preset}
                  expanded={expandedId === preset.id}
                  onToggle={() => toggle(preset.id)}
                />
              ))}
            </div>
          </>
        ) : null}
        <div className={boardStyles.messages}>
          {tools.loading && !data ? (
            <div className={boardStyles.empty}>Reading extensions…</div>
          ) : null}
          {data && !presets.length ? (
            <div className={boardStyles.empty}>
              No local extensions configured. A configured MCP preset appears here when the gateway
              can read it.
            </div>
          ) : null}
          {presets.length && !visible.length ? (
            <div className={boardStyles.empty}>
              No extension matches.{' '}
              <button
                type="button"
                className={boardStyles.linkButton}
                onClick={() => {
                  setQuery('');
                  setBucket(null);
                }}
              >
                Clear filters
              </button>
            </div>
          ) : null}
        </div>
      </Board>
      <Text size="xs" c="dimmed">
        Preset definitions do not prove a package is installed. Installation is not probed here.
        Viewing this page reads existing process state. An extension starts when a client attaches
        to its bridge endpoint.
      </Text>
      <div className={styles.sections}>
      <section className={styles.panel} aria-label="Connect a coding client">
        <h2>Connect a coding client</h2>
        <p>
          Point a client that supports a custom OpenAI-compatible endpoint to this gateway, then use
          a gateway API key.
        </p>
        <div className={styles.links}>
          <Button
            size="xs"
            variant="default"
            component={Link}
            href="/dashboard/keys"
            leftSection={<Icon name="i-keys" />}
          >
            Open connection details
          </Button>
        </div>
      </section>
      <section className={styles.panel} aria-label="Conversation context through MCP">
        <h2>Conversation context through MCP</h2>
        <p>
          Configure a Streamable HTTP MCP client at this gateway&apos;s origin plus the path below,
          with a gateway inference key in its Authorization bearer header. It exposes the read-only{' '}
          <code>context_status</code> tool. Use the same session identity header as your inference
          client, or an explicit eight-character session ID when permitted by this deployment.
        </p>
        <CopyValue label="MCP path" value="/api/v1/mcp" />
        <p>
          The tool reads retained context evidence. Anonymous callers cannot select another session
          implicitly. Unknown sessions return no snapshot. This does not generate a completion,
          change context policy, or prove future context capacity.
        </p>
        <div className={styles.links}>
          <Link href="/dashboard/keys">Configure a gateway key</Link>
        </div>
      </section>
      </div>
      <details className="fold">
        <summary>Integration capabilities</summary>
        <p className="caption">
          Automatic client takeover, interception, and vendor-model remapping are not exposed by
          this gateway. Configure your client&apos;s endpoint directly.
        </p>
      </details>
        </div>
      </div>
    </div>
  );
}
