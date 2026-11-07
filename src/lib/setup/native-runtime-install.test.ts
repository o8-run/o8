import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNTIME_INSTALL_INFO } from './runtime-install';

// o8 next's setup shows install commands and setup links from a JSON copy.
// They must stay exactly the commands and links the desktop shows.
describe('native runtime install info', () => {
  it('matches the desktop install table', () => {
    const file = join(process.cwd(), 'native/o8-next/src/surfaces/setup/runtime-install.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(RUNTIME_INSTALL_INFO);
  });
});
