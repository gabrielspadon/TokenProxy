'use client';
import { SegmentedControl, TextInput } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { Icon } from '@/shared/components/Icon';
import styles from './board.module.css';

// The two decisions every working surface shares. The level is the sidebar's
// Everyday / Advanced choice; the density is one comfy / tidy choice for the
// whole application. Both persist per browser.
export const LEVEL_KEY = 'tokenproxy.navigation-mode';
export const DENSITY_KEY = 'tokenproxy.capacity-density';

export function useLevel() {
  const [mode] = useLocalStorage({ key: LEVEL_KEY, defaultValue: 'everyday' });
  return mode === 'advanced';
}

export function useDensity() {
  return useLocalStorage({ key: DENSITY_KEY, defaultValue: 'tidy' });
}

export function DensitySwitch({ value, onChange }) {
  return (
    <SegmentedControl
      size="xs"
      aria-label="Density"
      value={value}
      onChange={onChange}
      data={[
        { value: 'comfy', label: 'Comfy' },
        { value: 'tidy', label: 'Tidy' },
      ]}
      className={styles.density}
    />
  );
}

// The panel. Everyday surfaces render cards grouped by state; Advanced
// surfaces render dense rows. `layout` names which one is on screen so tests
// and styles can address it.
export function Board({ label, advanced, density, layout, children, ...rest }) {
  return (
    <section
      className={styles.board}
      aria-label={label}
      data-advanced={advanced || undefined}
      data-layout={layout || (advanced ? 'rows' : 'cards')}
      data-density={density}
      {...rest}
    >
      {children}
    </section>
  );
}

// The summary strip: one chip per bucket, each a filter, plus a note.
export function BoardSummary({ label, chips, active, onPick, note }) {
  return (
    <div className={styles.fleet} role="group" aria-label={label}>
      {chips.map((chip) => (
        <button
          key={chip.id ?? 'all'}
          type="button"
          className={styles.fleetChip}
          data-tone={chip.tone}
          aria-pressed={active === (chip.id ?? null)}
          onClick={() => onPick?.(chip.id ?? null)}
        >
          {chip.tone ? <i /> : null}
          <strong>{chip.count}</strong> {chip.label}
        </button>
      ))}
      {note ? (
        <span className={styles.fleetNote}>{note}</span>
      ) : null}
    </div>
  );
}

// The toolbar row: search, filter chips, sort, density, then the actions.
export function BoardToolbar({ search, onSearch, searchLabel = 'Search', children, actions }) {
  return (
    <div className={styles.toolbar}>
      {onSearch ? (
        <TextInput
          size="xs"
          className={styles.search}
          type="search"
          role="searchbox"
          aria-label={searchLabel}
          placeholder="Search"
          leftSection={<Icon name="i-search" />}
          value={search}
          onChange={(event) => onSearch(event.currentTarget.value)}
        />
      ) : null}
      {children}
      <span className={styles.spacer} />
      {actions}
    </div>
  );
}

// One state group of cards: dot, label, count, then the grid.
export function BoardGroup({ label, tone, count, children }) {
  return (
    <section className={styles.group} aria-label={`${label} ${count === 1 ? 'item' : 'items'}`}>
      <h3 className={styles.groupTitle} data-tone={tone}>
        <i />
        {label}
        <span>{count}</span>
      </h3>
      <div className={styles.cards}>{children}</div>
    </section>
  );
}

// A card: head (mark, identity, controls), state row, evidence lines.
export function Card({ id, bucket, expanded, label, head, state, children, detail }) {
  return (
    <article
      className={styles.card}
      data-account-id={id}
      data-expanded={expanded || undefined}
      data-bucket={bucket}
      aria-label={label}
    >
      <header className={styles.cardHead}>{head}</header>
      {state ? <div className={styles.cardState}>{state}</div> : null}
      <div className={styles.cardWindows}>{children}</div>
      {expanded && detail ? (
        <div className={styles.detail} role="region" aria-label="Selection details">
          {detail}
        </div>
      ) : null}
    </article>
  );
}

// The state word with its tone dot.
export function StateWord({ tone, children }) {
  return (
    <span className={styles.stateWord} data-tone={tone}>
      <i />
      {children}
    </span>
  );
}

// One evidence line on the shared grid: label, a meter or share bar, the
// value, a short note. `level` colours a status meter (good, warn, low,
// depleted); `shares` draws a composition bar instead (input, read, write).
export function EvidenceLine({ label, remaining, level, shares, unknown, value, note, stale, onInspect, title }) {
  const known = !unknown && Number.isFinite(remaining);
  return (
    <div className={styles.line} data-stale={stale || undefined} data-level={level || undefined} data-usage={shares ? true : undefined}>
      {onInspect ? (
        <button type="button" className={styles.lineLabel} title={title} onClick={onInspect}>
          {label}
        </button>
      ) : (
        <span className={styles.lineLabel} data-static title={title}>
          {label}
        </span>
      )}
      <div
        className={styles.meter}
        role={known ? 'meter' : undefined}
        aria-label={known ? `${label} remaining` : undefined}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? 100 : undefined}
        aria-valuenow={known ? remaining : undefined}
        data-unknown={!known && !shares ? true : undefined}
        title={title}
      >
        {shares ? (
          <span className={styles.shares}>
            {shares.map((share) => (
              <i key={share.kind} style={{ width: `${share.percent}%` }} data-share={share.kind} />
            ))}
          </span>
        ) : known ? (
          <span className={styles.fill} style={{ width: `${remaining}%` }} />
        ) : null}
      </div>
      <span className={styles.lineValue} data-usage={shares ? true : undefined}>
        {value}
      </span>
      <span className={styles.lineReset}>{note}</span>
    </div>
  );
}

export { styles as boardStyles };
