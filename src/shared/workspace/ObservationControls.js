'use client';
import { SegmentedControl, Tooltip } from '@mantine/core';
import { useWorkspace } from './WorkspaceProvider';
import styles from './workspace.module.css';
import local from './observationControls.module.css';

// The internal enum stays summary|live|paused so a stored preference and every
// consumer keep working. Only the rail's wording changed: "Summary" named a
// shape of data, when what it selects is who triggers the read. "Snapshot" was
// unavailable -- this same rail already prints it for an isolated captured
// dataset -- so the non-automatic mode is Manual.
//
// Manual is not "no reads": every mode reads each source ONCE when a page
// opens, because a workspace with nothing on screen has nothing to hold. What
// Manual withholds is the repeat.
const BEHAVIORS = [
  { value: 'summary', label: 'Manual' },
  { value: 'live', label: 'Live' },
  { value: 'paused', label: 'Paused' },
];
// Said where the choice is made, so the operator does not have to open a
// tooltip to learn whether the screen is reading. Per-panel freshness stays
// authoritative for when each source last succeeded.
const BEHAVIOR_NOTE = {
  summary: 'Reads each source once when a page opens. Refresh to read again.',
  live: 'Rechecks every 15 seconds and follows supported streams.',
  paused: 'No repeating reads or streams. Shown values are held until you refresh.',
};
const utcClock = (value) => `${new Date(value).toISOString().slice(11, 19)} UTC`;

// How the workspace observes its sources is chosen in place in the rail and
// applies at once. The reasoning behind each behavior lives in the tooltip, so
// the rail carries the choice, its state and at most one short line.
export function ObservationControls() {
  const { observations, scope, snapshot, setScope, refresh } = useWorkspace();
  const fixedRange = Boolean(scope.start || scope.end);
  const state = snapshot ? 'Snapshot' : observations.historical ? 'Historical' : null;
  function apply(next) {
    if (next === 'live' && !snapshot) {
      if (fixedRange) setScope({ period: 'all', start: null, end: null });
      observations.setMode('live');
      refresh();
    } else observations.setMode(next);
  }
  const explanation = [
    'Manual reads each visible source when it is opened. Live refreshes visible retained evidence on bounded intervals and reconnects supported streams. Pausing closes those streams and stops background reads. Selecting another record or explicitly refreshing still reads its evidence.',
    'The chosen behavior is kept for this browser and applies to every page until it is changed. Each source keeps its own observation age. Resuming re-reads current state; events that were not retained during a pause cannot be recovered. Dashboard refresh does not request provider authentication or inference.',
    snapshot &&
      'Fixed isolated snapshot. Live updates are unavailable for this captured dataset. Permitted local changes can be verified with an explicit refresh.',
    !snapshot &&
      fixedRange &&
      'Return to current evidence. Following live clears the fixed UTC range and includes newly retained records. Provider, account, model and selected evidence remain unchanged.',
    observations.pausedAt && `Background reads paused at ${observations.pausedAt}.`,
  ].filter(Boolean);
  return (
    <div
      className={styles.railSetting}
      data-observation-control
      data-observation-mode={observations.mode}
      data-disabled={snapshot ? true : undefined}
    >
      <div className={styles.railHead}>
        <span>Updates</span>
        {state && <span className={styles.railState}>{state}</span>}
      </div>
      <Tooltip
        multiline
        w={320}
        position="right-end"
        events={{ hover: true, focus: true, touch: false }}
        label={
          <div className={styles.railTip}>
            {explanation.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        }
      >
        <SegmentedControl
          fullWidth
          size="xs"
          aria-label="Update behavior"
          value={observations.mode}
          onChange={apply}
          data={BEHAVIORS.map((item) => ({
            ...item,
            disabled: item.value === 'live' && Boolean(snapshot),
          }))}
        />
      </Tooltip>
      <p className={local.behavior}>
        {snapshot && observations.mode !== 'paused'
          ? 'Reads the captured dataset once. Live updates are unavailable for it.'
          : BEHAVIOR_NOTE[observations.mode]}
      </p>
      {observations.pausedAt && (
        <p className={styles.railNote}>
          Paused at{' '}
          <time dir="ltr" dateTime={observations.pausedAt}>
            {utcClock(observations.pausedAt)}
          </time>
        </p>
      )}
    </div>
  );
}
