import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_EVENT_DISCLOSURES } from '@/lib/analytics/events';
import { SCRUBBED_CRASH_SAMPLE } from './consent-sample';

// o8 next's first-run privacy page shows these disclosures from a JSON copy.
// They must stay the exact events and the exact scrubbed sample the desktop shows.
describe('native first-run privacy disclosures', () => {
  it('match the product event allowlist and the scrubbed crash sample', () => {
    const file = join(process.cwd(), 'native/o8-next/src/surfaces/setup/privacy-disclosures.json');
    const copy = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    expect(copy).toEqual({
      events: PRODUCT_EVENT_DISCLOSURES,
      examplePayload: JSON.stringify({ event: 'repo.added', props: { hasRemote: true, isGitRepo: true } }, null, 2),
      crashSample: JSON.stringify(SCRUBBED_CRASH_SAMPLE, null, 2),
    });
  });
});
