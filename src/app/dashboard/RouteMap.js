'use client';
import { useMemo } from 'react';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { fmtNum, fmtPct, fmtRelative } from '@/shared/format';
import { TONE, WORDS } from '@/shared/status';

const RANK = { bad: 3, warn: 2, ok: 1 };
const MAX_DOTS = 6;

// One lane per provider the gateway knows about today: every connected
// provider, every provider with a request in today's rollup, every provider
// with a session open right now. Ordered by today's share, then by what is in
// flight, so the lane the operator is looking for is near the top.
export function buildLanes(usage, conns) {
  const byProvider = usage?.byProvider || {};
  const sessions = usage?.activeSessions || [];
  const names = new Set([
    ...conns.map((c) => c.provider),
    ...Object.keys(byProvider),
    ...sessions.map((s) => s.provider),
  ]);
  const rows = Object.values(byProvider);
  const total = rows.reduce((n, r) => n + (r.requests || 0), 0);
  const peak = rows.reduce((n, r) => Math.max(n, r.promptTokens || 0, r.completionTokens || 0), 0);
  const lanes = [...names].filter(Boolean).map((provider) => {
    const r = byProvider[provider] || {};
    const mine = sessions.filter((s) => s.provider === provider);
    const own = conns.filter((c) => c.provider === provider);
    let tone = null;
    for (const c of own) {
      const t = TONE[c.status] || 'warn';
      if (!tone || RANK[t] > RANK[tone]) tone = t;
    }
    const failedNow = usage?.errorProvider && usage.errorProvider === provider;
    const worst = own.find((c) => (TONE[c.status] || 'warn') === tone);
    return {
      provider,
      requests: r.requests || 0,
      share: total ? (r.requests || 0) / total : 0,
      out: r.promptTokens || 0,
      back: r.completionTokens || 0,
      outFrac: peak ? (r.promptTokens || 0) / peak : 0,
      backFrac: peak ? (r.completionTokens || 0) / peak : 0,
      active: mine.filter((s) => s.status === 'active').length,
      done: mine.filter((s) => s.status === 'done').length,
      failed: mine.filter((s) => s.status === 'error').length + (failedNow ? 1 : 0),
      tone: failedNow ? 'bad' : tone,
      word: failedNow ? WORDS.error : worst ? WORDS[worst.status] || worst.status : null,
      draining: own.some((c) => c.isDraining),
    };
  });
  lanes.sort(
    (a, b) => b.requests - a.requests || b.active - a.active || a.provider.localeCompare(b.provider)
  );
  return {
    lanes,
    total,
    activeTotal: sessions.filter((s) => s.status === 'active').length,
  };
}

function Flow({ label, frac, value, kind }) {
  return (
    <span className="flow">
      <span className="k">{label}</span>
      <span className={`bar ${kind}`} aria-hidden="true" style={{ '--f': frac }} />
      <span className="v" data-i18n-skip>
        {fmtNum(value, { notation: 'compact', maximumFractionDigits: 1 })}
      </span>
    </span>
  );
}

function Count({ n, word }) {
  if (!n) return null;
  return (
    <span className="lane-count">
      <span data-i18n-skip>{fmtNum(n)}</span> <span>{word}</span>
    </span>
  );
}

// The route map. Text is the primary source: every fact the tracks, dots and
// bars draw is also a text node in the same lane, so a screen reader and a
// reduced-motion reader get the same facts. The drawn parts are aria-hidden.
export function RouteMap({ usage, conns, stream, receivedAt, now }) {
  const { lanes, total, activeTotal } = useMemo(() => buildLanes(usage, conns), [usage, conns]);
  const last = usage?.recentRequests?.[0]?.timestamp || null;
  const state = !usage ? 'waiting' : lanes.length === 0 ? 'empty' : activeTotal ? 'live' : 'idle';

  return (
    <section aria-labelledby="h-routing" className="routing">
      <div className="screen-head">
        <h2 id="h-routing">Routing now</h2>
        <Freshness status={stream.status} lastDataAt={receivedAt} />
      </div>
      {stream.status === 'stale' ? (
        <Notice
          tone="warn"
          title="The usage stream stopped."
          next="Counts below are from the last frame received. Reconnecting in the background."
        />
      ) : null}
      <div className="route" data-state={state} data-fresh={stream.status}>
        <div className="route-hub">
          <span className="label">Requests today</span>
          <span className="value" data-i18n-skip>
            {usage ? fmtNum(total) : '—'}
          </span>
          <span className="route-live">
            {state === 'waiting' ? (
              <span className="skeleton">Waiting for the first frame</span>
            ) : activeTotal ? (
              <>
                <span>Active requests</span>{' '}
                <span className="fig" data-i18n-skip>
                  {fmtNum(activeTotal)}
                </span>
              </>
            ) : (
              <>
                <span>Idle</span>
                {last ? (
                  <>
                    {' '}
                    <span>Last request</span>{' '}
                    <span className="fig" data-i18n-skip>
                      {fmtRelative(last, now)}
                    </span>
                  </>
                ) : null}
              </>
            )}
          </span>
        </div>
        {state === 'empty' ? (
          <p className="empty">No connection is configured. Add one under Connections.</p>
        ) : null}
        {lanes.length ? (
          <ol className="route-lanes" aria-label="Providers">
            {lanes.map((l) => (
              <li
                key={l.provider}
                className="lane"
                data-called={l.requests ? 'true' : 'false'}
                data-tone={l.tone || undefined}
                style={{ '--w': l.share }}
              >
                <span className="lane-track" aria-hidden="true" style={{ '--w': l.share }}>
                  {Array.from({ length: Math.min(l.active, MAX_DOTS) }, (_, i) => (
                    <span
                      key={i}
                      className="lane-dot"
                      style={{ '--i': i, '--at': (i + 1) / (Math.min(l.active, MAX_DOTS) + 1) }}
                    />
                  ))}
                  {l.failed ? (
                    <span className="lane-mark" data-tone="bad" />
                  ) : l.done ? (
                    <span className="lane-mark" data-tone="ok" />
                  ) : null}
                </span>
                <span className="lane-node">
                  <span className="name" data-i18n-skip>
                    {l.provider}
                  </span>
                  <span className="sub">
                    {l.requests ? (
                      <>
                        <span data-i18n-skip>{fmtPct(l.share)}</span> <span>of requests today</span>
                      </>
                    ) : (
                      <span>Not called today</span>
                    )}
                    {l.word ? (
                      <>
                        {' '}
                        <span className="status" data-tone={l.tone}>
                          {l.word}
                        </span>
                      </>
                    ) : null}
                    {l.draining ? (
                      <>
                        {' '}
                        <span>Draining</span>
                      </>
                    ) : null}
                  </span>
                  {l.active || l.done || l.failed ? (
                    <span className="sub">
                      <Count n={l.active} word="In flight" />
                      <Count n={l.done} word="Finished" />
                      <Count n={l.failed} word="Failed" />
                    </span>
                  ) : null}
                </span>
                <span className="lane-flow">
                  <Flow label="Tokens out" frac={l.outFrac} value={l.out} kind="out" />
                  <Flow label="Tokens in" frac={l.backFrac} value={l.back} kind="in" />
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <p className="caption">
        A lane is as thick as its share of requests today. A moving dot is a request open right now.
        The two bars are tokens sent out and received back today.
      </p>
      {usage?.errorProvider ? (
        <Notice tone="warn" title="A provider is returning errors." detail={usage.errorProvider} />
      ) : null}
    </section>
  );
}
