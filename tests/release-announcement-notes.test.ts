import { describe, expect, it } from 'vitest';
import { announcementBullets } from '../scripts/lib/stable-release-effects.mjs';

const SUBJECTS = [
  'feat(next): port first-run project step to o8 next (#5501)',
  'fix(native): keep the reviewer token scoped',
  'perf(chat): page a long chat history without deep copies',
  'chore: release v0.1.900',
];

describe('community release announcement lines', () => {
  it('uses the reviewed release notes in their own words', () => {
    const notes = '- Review findings go back to the agent that wrote the code.\n- o8 asks before it stops a mission.\n';
    expect(announcementBullets(notes, SUBJECTS)).toEqual([
      '- Review findings go back to the agent that wrote the code.',
      '- o8 asks before it stops a mission.',
    ]);
  });

  it('falls back to public commit subjects when the release has no notes', () => {
    const lines = announcementBullets('', SUBJECTS);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^- Port first-run project step/);
    expect(lines[1]).toBe('- Page a long chat history without deep copies');
  });

  it('falls back when the notes file is not a bullet list', () => {
    expect(announcementBullets('Not a list', SUBJECTS)).toHaveLength(2);
  });

  it('keeps at most six lines', () => {
    const notes = Array.from({ length: 8 }, (_, i) => `- Change number ${i + 1} ships.`).join('\n');
    expect(announcementBullets(notes, [])).toHaveLength(6);
  });
});
