import { fmtNum, fmtUsd } from '@/shared/format';
import { keyBudgetMeasurements } from './budget';

export function KeyBudget({ record }) {
  const budget = record.budget;
  const count = value => value == null ? 'Unknown' : fmtNum(value);
  return <div className="keys-budget">
    <p className="caption">Recorded usage and outstanding reservations are separate. A reservation is allowance held for unfinished or unresolved work, and does not establish a provider charge.</p>
    <div className="keys-budget-table" tabIndex={0} role="region" aria-label="Key budget measurements">
      <table>
        <caption>{budget?.recorded ? 'Lifetime application ledger' : 'Retained usage history'} · USD values are recorded estimates</caption>
        <thead><tr><th>Resource</th><th>Recorded</th><th>Held allowance</th><th>Ceiling</th><th>Missing evidence</th></tr></thead>
        <tbody>{keyBudgetMeasurements(record).map(row => {
          const render = value => value === null ? 'Unknown' : row.used === 'costUsd' ? fmtUsd(value) : fmtNum(value);
          return <tr key={row.used}><th scope="row">{row.label}</th><td>{render(row.recorded)}</td><td>{render(row.held)}</td>
            <td>{row.ceiling === null ? 'No ceiling' : render(row.ceiling)}</td>
            <td>{count(row.unknownRecorded)} recorded · {count(row.unknownHeld)} held</td></tr>;
        })}</tbody>
      </table>
    </div>
    <dl className="facts">
      <dt>Policy</dt><dd>{budget?.policy === 'strict' ? 'Verified bounds' : budget?.policy === 'reserve-remaining' ? 'Reserve remaining allowance' : 'Unknown'}</dd>
      <dt>Before dispatch</dt><dd>{count(budget?.outstanding?.reserved)} reservations</dd>
      <dt>Dispatched</dt><dd>{count(budget?.outstanding?.dispatched)} unresolved requests</dd>
      <dt>Uncertain outcome</dt><dd>{count(budget?.outstanding?.uncertain)} requests</dd>
    </dl>
    <p className="caption">{budget?.explanation || 'Budget evidence is unavailable. A valid key alone does not establish that the next request can be admitted.'}</p>
    {budget?.outstanding?.uncertain > 0 ? <p className="caption">Uncertain exposure remains held until supporting evidence resolves it. Restarting or waiting does not release it.</p> : null}
  </div>;
}
