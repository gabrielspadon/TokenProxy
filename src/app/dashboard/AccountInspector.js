'use client';
import Link from 'next/link';
import { usePoll } from '@/shared/hooks/usePoll';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { QuotaWindow } from '@/shared/components/QuotaWindow';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { fmtNum, fmtPct } from '@/shared/format';
import { WORDS, TONE } from '@/shared/status';
import { refusal } from '@/shared/refusal';

export function AccountInspector({ conns, selectedId, onSelect, quota, usage, healthError, now }) {
  const selected = conns.find((c) => c.connectionId === selectedId) || conns[0];
  const context = usePoll(
    selected
      ? `/api/context?connectionId=${encodeURIComponent(selected.connectionId)}&pageSize=1`
      : null,
    30000
  );
  const snapshots = (quota.data?.snapshots || []).filter(
    (s) => s.connectionId === selected?.connectionId
  );
  const windows = snapshots.flatMap((s) => s.windows || []);
  const summary = context.data?.summary;
  const models = [...new Set((context.data?.dimensions || []).map((d) => d.model).filter(Boolean))];
  const providerUsage = usage?.byProvider?.[selected?.provider];
  return (
    <section className="operator-panel account-inspector" aria-labelledby="health-title">
      <div className="panel-head">
        <h2 id="health-title">Account inspector</h2>
        <Link className="text-link" href="/dashboard/connections">
          Manage
          <Icon name="i-right" />
        </Link>
      </div>
      <div className="panel-body">
        {healthError ? <Notice {...healthError} /> : null}
        {!selected ? (
          <div className="chart-empty">
            <Icon name="i-connections" />
            <strong>No accounts connected</strong>
            <span>Connect a provider to inspect capacity.</span>
          </div>
        ) : (
          <>
            <label className="field inspector-account">
              <span>Inspect connection</span>
              <select
                className="select"
                value={selected.connectionId}
                onChange={(e) => onSelect(e.target.value)}
              >
                {conns.map((c) => (
                  <option key={c.connectionId} value={c.connectionId}>
                    {c.displayName || c.provider}
                  </option>
                ))}
              </select>
            </label>
            <div className="inspector-provider">
              <ProviderMark provider={selected.provider} label />
              <span className="status" data-tone={TONE[selected.status] || 'warn'}>
                {selected.isDraining ? 'Draining' : WORDS[selected.status] || selected.status}
              </span>
            </div>
            {selected.lastError ? <p className="inspector-warning">{selected.lastError}</p> : null}
            <div className="inspector-section">
              <h3>Quota & reset</h3>
              {quota.error ? (
                <Notice {...refusal(quota.status, quota.error)} />
              ) : windows.length ? (
                windows.map((w, i) => (
                  <QuotaWindow
                    key={i}
                    provider={selected.provider}
                    window={w}
                    horizonMs={6 * 3600000}
                    now={now}
                  />
                ))
              ) : (
                <p className="inspector-unknown">No quota measurement reported.</p>
              )}
            </div>
            <div className="inspector-section">
              <h3>Context on this account</h3>
              {context.error ? (
                <Notice {...refusal(context.status, context.error)} />
              ) : (
                <div className="inspector-pair">
                  <div>
                    <strong>{summary?.requests == null ? '—' : fmtNum(summary.requests)}</strong>
                    <span>retained requests</span>
                  </div>
                  <div>
                    <strong>
                      {summary?.cacheHitRate == null ? '—' : fmtPct(summary.cacheHitRate)}
                    </strong>
                    <span>measured cache share</span>
                  </div>
                </div>
              )}
              <p className="inspector-unknown">
                Cache share uses only provider-reported input and cache fields.
              </p>
            </div>
            <div className="inspector-section">
              <h3>Observed models</h3>
              {models.length ? (
                <div className="model-tags">
                  {models.slice(0, 4).map((model) => (
                    <span key={model}>
                      {model}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="inspector-unknown">No model usage recorded for this account.</p>
              )}
              <Link className="text-link" href="/dashboard/models">
                Review model routing
                <Icon name="i-right" />
              </Link>
            </div>
            <details className="inspector-section route-inspector">
              <summary>Provider traffic today</summary>
              <p>
                {providerUsage?.promptTokens == null
                  ? 'Input tokens not reported'
                  : `${fmtNum(providerUsage.promptTokens)} input tokens`}
              </p>
              <p>
                {providerUsage?.completionTokens == null
                  ? 'Output tokens not reported'
                  : `${fmtNum(providerUsage.completionTokens)} output tokens`}
              </p>
              <small>Includes every account for this provider.</small>
            </details>
            <Link
              className="button quiet inspector-open"
              href={`/dashboard/connections/${encodeURIComponent(selected.connectionId)}`}
            >
              Open account controls
              <Icon name="i-right" />
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
