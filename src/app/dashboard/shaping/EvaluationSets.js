'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';

export function EvaluationSets({ builtins, selected, onSelect, disabled }) {
  const [page, setPage] = useState(1), [library, setLibrary] = useState(null), [selectedSet, setSelectedSet] = useState(null);
  const [name, setName] = useState(''), [input, setInput] = useState(null), [fileName, setFileName] = useState(''), [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState(null), [saving, setSaving] = useState(false), [revision, setRevision] = useState(null);
  const fileRead = useRef(0);
  useEffect(() => () => { fileRead.current++; }, []);
  const readLibrary = useCallback(() => call(`/api/admin/shaping/evaluation-sets?page=${page}&pageSize=10`), [page]);
  const applyLibrary = useCallback(response => {
    if (response.ok) setLibrary(response.body);
    else setNotice({ tone: 'warn', title: 'Evaluation sets unavailable', children: 'The retained set library could not be read. Built-in cases remain available.' });
  }, []);
  async function refresh() { applyLibrary(await readLibrary()); }
  useEffect(() => {
    let active = true;
    void readLibrary().then(response => { if (active) applyLibrary(response); });
    return () => { active = false; };
  }, [readLibrary, applyLibrary]);
  useEffect(() => {
    let active = true;
    if (!selected || builtins.some(set => set.id === selected)) return;
    void call(`/api/admin/shaping/evaluation-sets/${selected}`).then(response => {
      if (!active) return;
      if (response.ok) setSelectedSet(response.body);
      else setNotice({ tone: 'warn', title: 'Selected evaluation set unavailable', children: response.body?.code });
    });
    return () => { active = false; };
  }, [selected, builtins]);
  async function readFile(file) {
    const generation = ++fileRead.current;
    setInput(null); setConsent(false); setNotice(null); setFileName(file?.name || '');
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setNotice({ tone: 'warn', title: 'File too large', children: 'Choose a JSON set of at most 8 MiB.' }); return; }
    try {
      const value = JSON.parse(await file.text());
      if (generation !== fileRead.current) return;
      if (!Array.isArray(value)) throw new Error();
      setInput(value);
    } catch { if (generation === fileRead.current) setNotice({ tone: 'warn', title: 'Invalid evaluation file', children: 'Use a JSON array of cases with id, contextWindow and a Claude-format body.' }); }
  }
  async function save() {
    setSaving(true); setNotice(null);
    try {
      const response = await call('/api/admin/shaping/evaluation-sets', { method: 'POST', body: { name, fixtures: input,
        acknowledgeRetention: consent, ...(revision ? { setId: revision.setId, expectedRevision: revision.revision } : {}) } });
      if (!response.ok) { setNotice({ tone: 'warn', title: 'Set was not saved', children: response.body?.code }); return; }
      onSelect(response.body.version.id); setSelectedSet(response.body.version); setConsent(false); setRevision(null);
      setNotice(response.status === 207 ? { tone: 'warn', title: 'Persistence unconfirmed', children: response.body.recovery } : { tone: 'ok', title: 'Evaluation set version saved', children: 'Its inputs are retained locally. No model request was sent.' });
      await refresh();
    } finally { setSaving(false); }
  }
  const options = [...builtins, ...(library?.rows || [])];
  const visibleSelectedSet = selectedSet?.id === selected ? selectedSet : null;
  if (visibleSelectedSet && !options.some(set => set.id === visibleSelectedSet.id)) options.push(visibleSelectedSet);
  return <section className="shaping-evaluation-sets" aria-label="Evaluation sets">
    <div className="shaping-set-picker"><label>Evaluation set<select value={selected} onChange={event => onSelect(event.target.value)} disabled={disabled || saving}>
      <option value="">Select retained cases</option>{options.map(set => <option key={set.id} value={set.id}>{set.name} v{set.revision} ({set.count} cases){set.synthetic ? ' · synthetic' : ''}</option>)}
    </select></label><div className="actions"><button className="button quiet" disabled={page === 1 || saving} onClick={() => setPage(page - 1)}>Previous sets</button><span>Page {page} of {library?.pagination?.pages || 1}</span><button className="button quiet" disabled={page >= (library?.pagination?.pages || 1) || saving} onClick={() => setPage(page + 1)}>Next sets</button></div></div>
    {visibleSelectedSet ? <p className="caption">Selected {visibleSelectedSet.count} cases, version {visibleSelectedSet.revision}. <code>{visibleSelectedSet.contentHash?.slice(0, 16)}</code> identifies the retained inputs. <button className="button quiet" onClick={() => { setRevision(visibleSelectedSet); setName(visibleSelectedSet.name); setConsent(false); }}>Create next version</button></p> : null}
    <div className="shaping-set-import"><label>{revision ? `New version of ${revision.name}` : 'New evaluation set'}<input aria-label="Evaluation set name" value={name} maxLength={100} onChange={event => setName(event.target.value)} disabled={disabled || saving} /></label>
      <label>Selected JSON cases<input type="file" accept="application/json,.json" onChange={event => void readFile(event.target.files?.[0])} disabled={disabled || saving} /></label>
      <span className="caption">{input ? `${input.length} cases read from ${fileName}` : 'Up to 64 cases, 1 MiB per request, 8 MiB per set.'}</span>
      <label className="shaping-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={disabled || saving} />Retain these selected request bodies locally for comparison. I have reviewed their contents.</label>
      <button className="button" disabled={disabled || saving || !consent || !input || !name.trim()} onClick={save}>{saving ? 'Saving set' : 'Save evaluation set'}</button>
      {revision ? <button className="button quiet" onClick={() => { setRevision(null); setConsent(false); }}>Save as a new set instead</button> : null}
    </div>
    <p className="caption">Each JSON case needs an id, contextWindow and body with messages. Only Claude-format request bodies are evaluated. Importing a case does not establish its task outcome or grant permission to replay it upstream.</p>
    {notice ? <Notice {...notice} /> : null}
  </section>;
}
