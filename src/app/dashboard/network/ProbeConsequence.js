import { PROBE_CONSEQUENCE } from '@/shared/workspace/operationHistoryModel';

/**
 * The consequence of the probe, next to the control rather than behind a
 * hover. A tooltip is not disclosure: it is unreachable by touch, it vanishes
 * on scroll, and an operator who never hovers never learns that pressing Test
 * can disable a pool every bound connection routes through.
 */
export function ProbeConsequence({ id }) {
  return (
    <div className="network-consequence" id={id}>
      <p className="network-consequence-title">{PROBE_CONSEQUENCE.title}</p>
      <dl className="facts">
        <dt>Scope</dt>
        <dd>{PROBE_CONSEQUENCE.scope}</dd>
        <dt>Timing</dt>
        <dd>{PROBE_CONSEQUENCE.timing}</dd>
        <dt>Reversing it</dt>
        <dd>{PROBE_CONSEQUENCE.reversal}</dd>
        <dt>Leaves activation alone</dt>
        <dd>{PROBE_CONSEQUENCE.unchanged}</dd>
      </dl>
    </div>
  );
}
