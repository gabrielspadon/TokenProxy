import { parseWindow } from './contextModel';
export function parseBulkOverrides(setText, removeText) {
  const set = [], deleteKeys = [], seen = new Set();
  for (const line of setText.split('\n').map(value => value.trim()).filter(Boolean)) {
    const separator = line.lastIndexOf('='), key = line.slice(0, separator).trim(), contextWindow = parseWindow(line.slice(separator + 1).trim());
    if (separator <= 0 || !key || contextWindow === null) throw new Error('Each set line needs an exact key = positive whole tokens.');
    if (seen.has(key)) throw new Error('Use each exact key once across set and remove.');
    seen.add(key); set.push({ key, contextWindow });
  }
  for (const key of removeText.split('\n').map(value => value.trim()).filter(Boolean)) {
    if (seen.has(key)) throw new Error('Use each exact key once across set and remove.');
    seen.add(key); deleteKeys.push(key);
  }
  if (!seen.size || seen.size > 1000) throw new Error('Review between 1 and 1,000 distinct keys at a time.');
  return { set, deleteKeys };
}
export function reviewBulkOverrides(patch, current) {
  return { ...patch, expectedOverrides: Object.fromEntries([...patch.set.map(item => item.key), ...patch.deleteKeys].map(key => [key, Object.hasOwn(current, key) ? current[key] : null])) };
}
export function bulkReadbackMatches(patch, current) {
  return Boolean(current) && patch.set.every(item => current[item.key] === item.contextWindow) && patch.deleteKeys.every(key => !Object.hasOwn(current, key));
}
