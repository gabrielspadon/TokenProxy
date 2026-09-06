'use client';
import { Freshness } from '@/shared/components/Freshness';

// §14 (Local Tool Integrations) and §15 (Local Extension Bridge). Neither
// backend surface answers a read today: `/api/cli-tools/**` is documented in
// docs/contract/06-tools-system.md §2 (all-statuses, per-tool settings,
// antigravity-mitm) but is absent from the source tree and returns 404 live
// (verified against 127.0.0.1:20143). `/api/mcp/[plugin]/{sse,message}` is
// live (docs/contract/06-tools-system.md:123-126) but has no index or
// status route, so "which extensions are running" is unanswerable without
// opening a connection, which spawns a child process as a side effect.
export default function ToolsPage() {
  return (
    <>
      <div className="screen-head">
        <h1>Tools</h1>
        <Freshness status="live" lastDataAt={null} />
      </div>

      <section aria-labelledby="h-integrations">
        <h2 id="h-integrations">Tool integrations</h2>
        <p>
          A tool integration is one coding agent installed on this machine whose configuration the
          gateway can take over, so its traffic arrives here instead of at its vendor. Some tools
          expose a configurable endpoint; others can only be reached by intercepting their traffic,
          which changes machine-wide name resolution and the certificate trust store rather than
          only the tool.
        </p>
        <p className="empty">
          No route currently answers which tools are present, taken over, or intercepted, so this
          screen cannot list them or offer a take-over, hand-back, model-mapping, or interception
          action.
        </p>
      </section>

      <section aria-labelledby="h-bridge">
        <h2 id="h-bridge">Local extension bridge</h2>
        <p>
          A local extension is a program on this machine that speaks a line-oriented protocol over
          its own input and output. The bridge relays a connected tool&apos;s calls to that program
          over a server-sent-events connection, opening the extension&apos;s process the first time
          a tool attaches and truncating or collapsing its output before relaying it.
        </p>
        <p className="empty">
          No route reports which extensions are available, which are running, or whether a tool is
          attached right now. Opening that view would mean starting an extension&apos;s process as a
          side effect of viewing a dashboard, so this screen does not attempt it.
        </p>
      </section>

      <section aria-labelledby="h-gap">
        <h2 id="h-gap">Not reported</h2>
        <p>Two facts this screen would otherwise show have no route to read them from.</p>
        <ul className="bullets">
          <li>
            Every tool-integration attribute and action: which tools are present, taken over, or
            intercepted; what was written into a tool&apos;s configuration and what it replaced; how
            a tool&apos;s vendor model names map onto gateway models; and whether the interception
            redirection and certificate are currently in place. The backing libraries exist on disk,
            but no HTTP route calls them.
          </li>
          <li>
            Whether a local extension is running and whether a tool is attached to it. The bridge
            itself works end to end once a tool connects; only its status is unreported here.
          </li>
        </ul>
      </section>
    </>
  );
}
