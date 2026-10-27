import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const metrics = ['x', 'y', 'width', 'height', 'fontSize', 'fontWeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

export function writeReport(captures, output, manifest) {
  mkdirSync(output, { recursive: true });
  const cases = captures.map(capture => {
    const elements = {};
    const names = new Set([...Object.keys(manifest.elements), ...Object.keys(capture.native ?? {}), ...Object.keys(capture.web ?? {})]);
    for (const name of names) {
      const native = capture.native?.[name] ?? null;
      const web = capture.web?.[name] ?? null;
      const gap = Object.fromEntries(metrics.map(key => [key,
        Number.isFinite(native?.[key]) && Number.isFinite(web?.[key])
          ? Math.round((native[key] - web[key]) * 100) / 100 : null]));
      elements[name] = { native, web, gap,
        status: !native ? 'Missing' : !web || Object.values(gap).some(value => value === null || value !== 0) ? 'Partial' : 'Done' };
    }
    return { ...capture, elements, status: capture.crash ? 'Crash' : 'Partial' };
  });
  const report = { schema: 1, units: 'logical px; gap = native - current UI',
    sizes: manifest.sizes, crashes: cases.filter(row => row.crash).length,
    limitations: [
      'Native bounds use GPUI TestAppContext and its test text system, separately from X11 pixel captures.',
      'Native computed font sizes, weights and paddings are unavailable in the public test API; null means unmeasured.',
      'Missing selectors or unopened counterparts remain Partial/Missing and never pass as parity.',
      'Linux captures the plain native fallback; browser All Glass has no desktop wallpaper or system material.',
    ], cases };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const cards = cases.map(row => `<article><h2>${escape(row.surface)} · ${row.size.join(' × ')} · ${row.status}</h2>${row.images?.pair ? `<a href="${escape(row.images.pair)}"><img loading="lazy" src="${escape(row.images.pair)}" alt="Current UI left; o8 next right"></a>` : ''}<pre>${escape(JSON.stringify(row.elements, null, 2))}</pre></article>`).join('\n');
  writeFileSync(join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>o8 next parity</title><style>body{font:300 14px system-ui;background:#181b20;color:#eee;margin:24px}img{width:100%}pre{overflow:auto;max-height:320px}article{margin-bottom:32px}</style><h1>o8 next parity</h1><p>Current UI left · o8 next right. Measurements are in report.json.</p>${cards}\n`);
  return report;
}
