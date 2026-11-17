import { describe, expect, it } from 'vitest';
import { readChosenMachineName, readMachineName } from './machine-name';

describe('readMachineName', () => {
  it('uses the name set in macOS Sharing settings', () => {
    expect(readMachineName('darwin', () => 'Studio iMac\n', () => 'studio-imac.local')).toBe('Studio iMac');
  });

  it('falls back to the host name without its local suffix', () => {
    expect(readMachineName('darwin', () => { throw new Error('unset'); }, () => 'studio-imac.local')).toBe('studio-imac');
    expect(readMachineName('linux', () => 'never read', () => 'build-box')).toBe('build-box');
  });

  it('never returns an empty name', () => {
    expect(readMachineName('linux', () => '', () => '')).toBe('This computer');
  });
});

describe('readChosenMachineName', () => {
  it('uses the first line of the owner\'s file', () => {
    expect(readChosenMachineName(() => '  Linux box \nnotes\n')).toBe('Linux box');
  });

  it('is absent when the file is missing or blank', () => {
    expect(readChosenMachineName(() => { throw new Error('ENOENT'); })).toBeNull();
    expect(readChosenMachineName(() => '\n')).toBeNull();
  });
});
