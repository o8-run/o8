import { describe, expect, it } from 'vitest';
import { pushLfsObjects } from './lfs-push';

const base = 'b'.repeat(40);
const commit = 'a'.repeat(40);

describe('pushLfsObjects', () => {
  it('reads LFS use from the base commit and passes Git only resolved commits', async () => {
    const calls: string[][] = [];
    await pushLfsObjects(async (args) => {
      calls.push(args);
      if (args[0] !== 'rev-parse') return { stdout: '' };
      return { stdout: `${args[4].startsWith('--open') ? commit : base}\n` };
    }, 'origin', '--open-files-in-pager=touch', 'main');
    expect(calls).toEqual([
      ['rev-parse', '--verify', '--quiet', '--end-of-options', 'main^{commit}'],
      ['grep', '-q', '-F', 'filter=lfs', base, '--', '.gitattributes', '*/.gitattributes'],
      ['rev-parse', '--verify', '--quiet', '--end-of-options', '--open-files-in-pager=touch^{commit}'],
      ['lfs', 'version'],
      ['lfs', 'push', 'origin', commit],
    ]);
  });

  it('makes no Git call without a recorded base', async () => {
    const calls: string[][] = [];
    await pushLfsObjects(async (args) => { calls.push(args); return { stdout: '' }; }, 'origin', commit, null);
    expect(calls).toEqual([]);
  });

  it('makes no LFS call when the base routes no files to LFS', async () => {
    const calls: string[][] = [];
    await pushLfsObjects(async (args) => {
      calls.push(args);
      if (args[0] === 'grep') throw Object.assign(new Error('no match'), { code: 1 });
      return { stdout: `${base}\n` };
    }, 'origin', commit, base);
    expect(calls.map((args) => args[0])).toEqual(['rev-parse', 'grep']);
  });
});
