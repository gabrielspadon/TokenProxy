'use client';
import { useState } from 'react';
import { NumberInput } from '@mantine/core';
import { nativeCompactionBoundary } from '@/lib/clientSetup/nativeCompaction.mjs';

export function NativeClientBoundary() {
  const [advertised, setAdvertised] = useState(''), [window, setWindow] = useState(''), [output, setOutput] = useState('');
  const result = nativeCompactionBoundary({ version: '2.1.263', advertisedContext: advertised, resolvedWindow: window, maxOutput: output });
  const value = n => n === null ? 'Unknown' : n.toLocaleString();
  return <section aria-label="Native client context boundary">
    <h3>Native client context boundary</h3>
    <p>Claude Code 2.1.263 source calculation. Enter observed quantities; this does not read or change a running client.</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
    <NumberInput label="Gateway advertised context tokens" value={advertised} onChange={setAdvertised} min={1} allowDecimal={false} />
    <NumberInput label="Native resolved window tokens" description="Use the client’s resolved window, which can differ from the gateway catalog." value={window} onChange={setWindow} min={100000} max={1000000} allowDecimal={false} />
    <NumberInput label="Native model maximum output tokens" value={output} onChange={setOutput} min={1} allowDecimal={false} />
    </div>
    <dl className="facts">
      <dt>Advertised context</dt><dd>{value(result.advertisedContext)} tokens</dd>
      <dt>Output reserve</dt><dd>{value(result.outputReserve)} tokens</dd>
      <dt>Effective window</dt><dd>{value(result.effectiveWindow)} tokens</dd>
      <dt>Compaction reserve</dt><dd>{value(result.compactionReserve)} tokens</dd>
      <dt>Calculated trigger at 100%</dt><dd>{value(result.threshold)} tokens</dd>
    </dl>
    <p>A 200k window with at least 20k maximum output triggers at 167k (83.5%), even at 100%. <code>autoCompactWindow</code> cannot remove either reserve or exceed the selected model window.</p>
    <p>Eligible exact gateway models may need explicit <code>[1m]</code> selection. Bare Fable and Opus gateway IDs report 200k in this native version. Resumed sessions retain their selection; catalog labels do not update it.</p>
    <p>Opt in with <code>scripts/tokenproxy-client-config.mjs</code> and a client key in <code>TOKENPROXY_API_KEY</code>. The PostCompact hook reports completion without transcript content. Its omitted token counts remain unknown.</p>
  </section>;
}
