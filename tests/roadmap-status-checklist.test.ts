import { describe, expect, it } from 'vitest';
import { checklistItems, countChecklist } from '../scripts/roadmap-status.mjs';

describe('roadmap-status checklist sections (#2233)', () => {
  it('counts and lists the same last Checklist section', () => {
    const body = ['## Outcome', 'Ship it.', '', '## Checklist', '- [x] #10 first', '- [ ] #11 second', '', '## Done when', 'All shipped.'].join('\n');
    const comment = ['Corrected list:', '', '## Checklist', '- [x] #20 replaces first', '- [x] #21 replaces second', '- [ ] #22 added'].join('\n');
    const texts = [body, comment];
    const items = checklistItems(texts);
    const { checked, total } = countChecklist(texts);
    expect(items.map((item) => item.num)).toEqual([20, 21, 22]);
    expect(total).toBe(items.length);
    expect(checked).toBe(items.filter((item) => item.checked).length);
  });

  it('keeps the body section when a later Checklist heading has no boxes', () => {
    const body = ['## Checklist', '- [x] #30 done', '- [ ] #31 open'].join('\n');
    const texts = [body, '## Checklist\nNothing yet.'];
    expect(countChecklist(texts)).toEqual({ checked: 1, total: 2 });
    expect(checklistItems(texts).map((item) => item.num)).toEqual([30, 31]);
  });
});
