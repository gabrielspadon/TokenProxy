// Behavior only. Nothing here asserts a margin, a colour or a pixel.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');
// JSX wraps prose across lines, so compare on collapsed whitespace: what
// matters is that the sentence still reaches the reader, not how it is wrapped.
const flat = (s) => s.replace(/\s+/g, ' ');

describe('catalog and tools page-local UI', () => {
  const models = read('src/app/dashboard/models/page.js');
  const tools = read('src/app/dashboard/tools/page.js');
  const toolsCss = read('src/app/dashboard/tools/tools.module.css');

  it('gives every truncated model identifier an accessible exact value', () => {
    // .models-id is nowrap + ellipsis, so the rendered text is lossy. Each
    // render site must carry the untruncated string on title.
    const sites = models.match(/className="models-id"[^>]*/g) || [];
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) expect(site).toMatch(/title=\{/);
  });

  it('keeps model identifiers left-to-right regardless of document direction', () => {
    const sites = models.match(/className="models-id"[^>]*/g) || [];
    for (const site of sites) expect(site).toMatch(/dir="ltr"/);
  });

  it('preserves every sentence of the MCP scope copy when folded', () => {
    // The fold is presentation. Losing a caveat would be a truthfulness change.
    for (const sentence of [
      'Anonymous callers cannot select another session',
      'Unknown sessions return no snapshot',
      'change context policy, or prove future context capacity',
      'eight-character session ID when permitted by this deployment',
    ])
      expect(flat(tools)).toContain(sentence);
  });

  it('keeps the connecting instruction and the endpoint outside the fold', () => {
    const foldAt = tools.indexOf('<details className={styles.note}>');
    expect(foldAt).toBeGreaterThan(-1);
    // Both the Authorization instruction and the copyable path precede it.
    expect(tools.indexOf('Authorization bearer header')).toBeLessThan(foldAt);
    expect(tools.indexOf('<CopyValue label="MCP path"')).toBeLessThan(foldAt);
  });

  it('renders the two connect panels as peers sharing one edge', () => {
    expect(toolsCss).toMatch(/\.sections\s*\{[^}]*align-items:\s*stretch/);
    // Each panel still top-aligns its own content.
    expect(toolsCss).toMatch(/\.panel\s*\{[^}]*align-content:\s*start/);
  });

  it('gives the folded summary a visible keyboard focus state', () => {
    expect(toolsCss).toMatch(/\.note\s*>\s*summary:focus-visible/);
  });
});
