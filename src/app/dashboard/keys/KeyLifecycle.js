import { Notice } from '@/shared/components/Notice';
import { fmtNum, fmtRelative } from '@/shared/format';

// Which profile a key follows and how it has diverged. The two signals are
// shown as separate sentences because they call for different actions: a
// drifted key was edited by hand, a key that is behind was left where it was
// while its profile moved on.
function Profile({ record, profiles }) {
  const compliance = record.profile;
  if (!compliance) {
    return (
      <dl className="facts">
        <dt>Access profile</dt>
        <dd>Managed by hand. This key follows no profile.</dd>
      </dl>
    );
  }
  const named =
    compliance.profileName || profiles?.find((p) => p.id === compliance.profileId)?.name || null;
  return (
    <dl className="facts">
      <dt>Access profile</dt>
      <dd>
        {named ? (
          <span data-i18n-skip>{named}</span>
        ) : (
          <span>A profile this key names is no longer defined.</span>
        )}
        {compliance.adoptedVersion !== null ? (
          <>
            {' '}
            <span>Adopted at version</span>{' '}
            <span data-i18n-skip>{fmtNum(compliance.adoptedVersion)}</span>
          </>
        ) : null}
        {compliance.adoptedVersion !== null && compliance.currentVersion !== null ? (
          <>
            {' '}
            <span>of</span> <span data-i18n-skip>{fmtNum(compliance.currentVersion)}</span>
          </>
        ) : null}
        .
      </dd>
      <dt>Agreement</dt>
      <dd>
        {compliance.baseline === 'unavailable' ? (
          <span>
            The version this key adopted is no longer retained, so nothing can vouch for it.
          </span>
        ) : compliance.drifted ? (
          <span>
            This key was changed away from the version it adopted:{' '}
            <span data-i18n-skip>{compliance.driftedFields.join(', ')}</span>.
          </span>
        ) : (
          <span>This key matches the version it adopted.</span>
        )}
        {compliance.behind ? (
          <> The profile has since moved on. Re-adopting would apply the current version.</>
        ) : null}
      </dd>
    </dl>
  );
}

// Both sides of a rotation. The superseded key gets the deadline, because
// that is the date on which someone's traffic stops.
function Rotation({ record, now }) {
  const rotation = record.rotation;
  if (!rotation) return null;
  const superseded = rotation.role === 'superseded';
  return (
    <>
      {superseded ? (
        <Notice
          tone="warn"
          title="A successor has been issued for this key."
          next={`This key keeps working until its overlap window ends ${fmtRelative(rotation.overlapEndsAt, now)}, then stops on its next use. Move every client to the successor before then.`}
        />
      ) : null}
      <p className="caption">
        {superseded ? (
          <>
            Rotated <span data-i18n-skip>{fmtRelative(rotation.rotatedAt, now)}</span>.
          </>
        ) : (
          <>
            This key replaced an earlier one{' '}
            <span data-i18n-skip>{fmtRelative(rotation.rotatedAt, now)}</span>. The earlier key
            stays valid until
            {rotation.overlapEndsAt ? (
              <>
                {' '}
                <span data-i18n-skip>{fmtRelative(rotation.overlapEndsAt, now)}</span>
              </>
            ) : (
              <> its own expiry</>
            )}
            .
          </>
        )}
      </p>
      <dl className="facts">
        <dt>{superseded ? 'Successor' : 'Replaced'}</dt>
        <dd className="id" data-i18n-skip>
          {rotation.counterpartKeyId}
        </dd>
        <dt>Overlap chosen</dt>
        <dd data-i18n-skip>{fmtNum(rotation.overlapHours)}h</dd>
      </dl>
    </>
  );
}

// Retained attribution, which is a different question from the live client
// count in the row above. Absent data says so rather than reading as zero.
function Attribution({ record, now }) {
  const attribution = record.attribution;
  return (
    <dl className="facts">
      <dt>Last client</dt>
      <dd>
        {!attribution ? (
          <span>Unknown. No attributed request is retained for this key.</span>
        ) : attribution.attribution === 'unattributed' ? (
          <span>
            Unknown. <span data-i18n-skip>{fmtNum(attribution.requests)}</span> retained requests
            named no client.
          </span>
        ) : (
          <>
            <span data-i18n-skip>{attribution.clientTool}</span>
            {attribution.lastSeenAt ? (
              <>
                {' '}
                <span data-i18n-skip>{fmtRelative(attribution.lastSeenAt, now)}</span>
              </>
            ) : null}
          </>
        )}
      </dd>
      {attribution ? (
        <>
          <dt>Distinct clients seen</dt>
          <dd data-i18n-skip>{fmtNum(attribution.distinctClients)}</dd>
        </>
      ) : null}
    </dl>
  );
}

export function KeyLifecycle({ record, profiles, now }) {
  return (
    <div className="keys-lifecycle">
      <Profile record={record} profiles={profiles} />
      <Rotation record={record} now={now} />
      <Attribution record={record} now={now} />
      <p className="caption">
        A client name is reported by the caller itself. It identifies which tool claims the key, not
        who is holding it.
      </p>
    </div>
  );
}
