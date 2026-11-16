import { describe, expect, it } from 'vitest';
import { readMachineName } from './machine-name';

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
