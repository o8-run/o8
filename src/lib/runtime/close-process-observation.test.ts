import { describe, expect, it, vi } from 'vitest';
import {
  closeObservedHelperSettled, closeProcessScanCounts, observeCloseProcess,
  refreshCloseProcessObservation, settleCloseObservedHelper, withCloseProcessObservation,
} from './close-process-observation';
import { parseOpenFileSnapshot } from './process-open-files-snapshot';
import * as openFiles from './process-open-files-snapshot';
import { parseProcessCwdSnapshot, readProcessCwdSnapshot } from './process-cwd-snapshot';
import { parseCloseProcessTable } from './close-process-table';

describe('close-scoped native observations', () => {
  it('single-flights one phase and refreshes both evidence and helper settlement at the next seam', async () => {
    const read = vi.fn(async () => 'native evidence');
    await withCloseProcessObservation(async () => {
      expect(await Promise.all([observeCloseProcess('open-files', read), observeCloseProcess('open-files', read)]))
        .toEqual(['native evidence', 'native evidence']);
      expect(read).toHaveBeenCalledTimes(1);
      settleCloseObservedHelper(12345);
      expect(closeObservedHelperSettled(12345)).toBe(true);
      refreshCloseProcessObservation();
      expect(closeObservedHelperSettled(12345)).toBe(false);
      await observeCloseProcess('open-files', read);
      expect(read).toHaveBeenCalledTimes(2);
      expect(closeProcessScanCounts()?.openFiles).toBe(2);
    });
    expect(closeObservedHelperSettled(12345)).toBe(false);
    await withCloseProcessObservation(async () => {
      await observeCloseProcess('open-files', read);
      expect(read).toHaveBeenCalledTimes(3);
    });
  });

  it('keeps an inconclusive observation failed throughout its phase', async () => {
    const read = vi.fn(async () => { throw new Error('inconclusive'); });
    await withCloseProcessObservation(async () => {
      await expect(observeCloseProcess('open-files', read)).rejects.toThrow('inconclusive');
      await expect(observeCloseProcess('open-files', read)).rejects.toThrow('inconclusive');
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  it('separates cwd descriptors from other names and preserves deleted-file holders', () => {
    const rows = parseOpenFileSnapshot('p12\ncnode\nfcwd\ntDIR\nn/owned\nf4\ntREG\nn/owned/file (deleted)\n');
    expect(rows.filter(row => row.descriptor === 'cwd').map(row => row.file)).toEqual(['/owned']);
    expect(rows[1]?.file).toBe('/owned/file');
  });

  it.each(['', 'p12\ncnode\nf4\ntREG\n', 'p12\ncnode\nf4\ntREG\nn\n', 'p12\ncnode\nf4\nn/file\nxextra\n'])(
    'refuses incomplete or unexpected descriptor protocol %j', raw => {
      expect(() => parseOpenFileSnapshot(raw)).toThrow();
    },
  );

  it('accepts only the known pathless native kernel objects', () => {
    expect(parseOpenFileSnapshot('p12\ncnode\nf4\ntPIPE\nn\n')[0]?.file).toBe('');
    expect(() => parseOpenFileSnapshot('p12\ncnode\nf4\ntUNKNOWN\nn\n')).toThrow();
  });

  it('marks unreadable cwd names without retaining a diagnostic as a path', () => {
    const raw = 'p12\ncnode\nLfixture-owner\nfcwd\ntunknown\nn/proc/12/cwd (readlink: Permission denied)\n';
    expect(parseOpenFileSnapshot(raw)).toEqual([
      { pid: 12, commandName: 'node', owner: 'fixture-owner', descriptor: 'cwd', file: '', unreadable: true },
    ]);
    expect(parseProcessCwdSnapshot(raw)).toEqual([
      { pid: 12, commandName: 'node', owner: 'fixture-owner', cwd: '', unreadable: true },
    ]);
  });

  it('does not carry ownership across process records', () => {
    const raw = 'p12\ncnode\nLfixture-owner\nfcwd\ntDIR\nn/outside\np13\ncnode\nfcwd\ntunknown\nn/proc/13/cwd (readlink: Permission denied)\n';
    expect(parseOpenFileSnapshot(raw)[1]).toMatchObject({ pid: 13, file: '', unreadable: true });
    expect(parseOpenFileSnapshot(raw)[1]?.owner).toBeUndefined();
    expect(parseProcessCwdSnapshot(raw)[1]).toMatchObject({ pid: 13, cwd: '', unreadable: true });
    expect(parseProcessCwdSnapshot(raw)[1]?.owner).toBeUndefined();
  });

  it.each(['Lfixture-owner\nLduplicate\n', 'L\n'])(
    'refuses ambiguous owner coverage %j', ownerFields => {
      const raw = `p12\ncnode\n${ownerFields}fcwd\ntDIR\nn/outside\n`;
      expect(() => parseOpenFileSnapshot(raw)).toThrow();
      expect(() => parseProcessCwdSnapshot(raw)).toThrow();
    },
  );

  it('keeps full process parent, group and marker identity and refuses malformed rows', () => {
    expect(parseCloseProcessTable('12 12 1 node O8_OWNED_RUN_MARKER=retained')).toEqual([
      { pid: 12, group: 12, parent: 1, command: 'node O8_OWNED_RUN_MARKER=retained' },
    ]);
    expect(() => parseCloseProcessTable('12 unknown')).toThrow();
  });

  it('projects repeated identical task cwd records as one process observation', async () => {
    const rows = parseOpenFileSnapshot('p12\ncnode\nfcwd\ntDIR\nn/owned\np12\ncnode\nfcwd\ntDIR\nn/owned\n');
    const read = vi.spyOn(openFiles, 'readCloseOpenFileRows').mockResolvedValue(rows);
    try {
      await withCloseProcessObservation(async () => {
        expect(await readProcessCwdSnapshot()).toMatchObject({
          status: 'ready', rows: [{ pid: 12, cwd: '/owned', commandName: 'node' }],
        });
      });
    } finally { read.mockRestore(); }
  });

  it('preserves conflicting task cwd records instead of selecting one', async () => {
    const rows = parseOpenFileSnapshot('p12\ncnode\nfcwd\ntDIR\nn/owned\np12\ncnode\nfcwd\ntDIR\nn/other\n');
    const read = vi.spyOn(openFiles, 'readCloseOpenFileRows').mockResolvedValue(rows);
    try {
      await withCloseProcessObservation(async () => {
        expect(await readProcessCwdSnapshot()).toMatchObject({ status: 'ready', rows: [
          { pid: 12, cwd: '/owned' }, { pid: 12, cwd: '/other' },
        ] });
      });
    } finally { read.mockRestore(); }
  });

  it('forceRefresh observes a new holder even when its PID was previously settled', async () => {
    const read = vi.spyOn(openFiles, 'readCloseOpenFileRows')
      .mockResolvedValueOnce(parseOpenFileSnapshot('p12\ncnode\nfcwd\ntDIR\nn/neutral\n'))
      .mockResolvedValueOnce(parseOpenFileSnapshot('p12\ncnode\nfcwd\ntDIR\nn/claim\n'));
    try {
      await withCloseProcessObservation(async () => {
        await readProcessCwdSnapshot();
        settleCloseObservedHelper(12);
        expect(await readProcessCwdSnapshot()).toMatchObject({ status: 'ready', rows: [] });
        expect(await readProcessCwdSnapshot({ forceRefresh: true })).toMatchObject({
          status: 'ready', rows: [{ pid: 12, cwd: '/claim' }],
        });
        expect(read).toHaveBeenCalledTimes(2);
      });
    } finally { read.mockRestore(); }
  });

  it('forceRefresh refuses newly inconclusive evidence after a clear cached observation', async () => {
    const read = vi.spyOn(openFiles, 'readCloseOpenFileRows')
      .mockResolvedValueOnce(parseOpenFileSnapshot('p12\ncnode\nfcwd\ntDIR\nn/neutral\n'))
      .mockRejectedValueOnce(new Error('native coverage became inconclusive'));
    try {
      await withCloseProcessObservation(async () => {
        expect((await readProcessCwdSnapshot()).status).toBe('ready');
        expect((await readProcessCwdSnapshot({ forceRefresh: true })).status).toBe('unavailable');
        expect(read).toHaveBeenCalledTimes(2);
      });
    } finally { read.mockRestore(); }
  });
});
