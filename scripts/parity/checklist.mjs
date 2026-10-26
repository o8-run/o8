/** Regenerate the measured table without changing the hand-maintained run instructions. */
import { readFileSync, writeFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./surfaces.json', import.meta.url), 'utf8'));
const report = { cases: process.argv.slice(2).flatMap(file => JSON.parse(readFileSync(file, 'utf8')).cases) };
const file = new URL('../../docs/internals/o8-next-parity.md', import.meta.url);
const owners = { sidebar: 4642, session: 4711, workers: 4736, brain: 4548, grid: 4530, activity: 4548, pull_requests: 4652,
  inbox: 4548, issues: 4548, diff: 4548, terminal: 4487, settings: 4548, projects: 4548,
  customize: 4548, setup: 4660, palette: 4702 };
const rows = [];
for (const surface of manifest.surfaces) {
  for (const element of Object.keys(manifest.elements)) {
    const samples = report.cases.filter(row => row.surface === surface.id);
    const measurements = samples.map(row => {
      const measured = row.elements?.[element];
      const values = Object.entries(measured?.gap ?? {}).filter(([, gap]) => gap !== null);
      return `${row.size.join('×')}: ${row.crash ? 'capture failed' : values.length
        ? values.map(([key, gap]) => `${key} ${gap >= 0 ? '+' : ''}${gap}`).join(', ') : 'unmeasured'}`;
    }).join('; ');
    const missing = ['rail', 'files'].includes(element);
    rows.push(`| ${surface.id} | ${element} | ${missing ? 'Missing' : 'Partial'} | [#${owners[surface.id]}](https://github.com/o8-run/o8/issues/${owners[surface.id]}) | ${measurements || 'No capture recorded'} |`);
  }
}
const content = readFileSync(file, 'utf8');
const start = '<!-- parity-table:start -->';
const end = '<!-- parity-table:end -->';
const table = `${start}\n| Surface | Element | Status | Owner | Measured gap (native − current UI, px) |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n${end}`;
writeFileSync(file, content.slice(0, content.indexOf(start)) + table + content.slice(content.indexOf(end) + end.length));
