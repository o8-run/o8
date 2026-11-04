import { describe, expect, it } from 'vitest';
import { parseOperatorDefaultsToml, serializeOperatorDefaultsToml } from '@/lib/settings/toml';
import { applyPresentationUpdate, presentationSettingSources, resolvePresentationDefaults } from './presentation-defaults';

describe('nativeKeybindings', () => {
  it('defaults to none and persists unique command=chord entries', () => {
    expect(resolvePresentationDefaults({}).nativeKeybindings).toEqual([]);
    const stored = {};
    applyPresentationUpdate(stored, { nativeKeybindings: ['shell.palette=cmd-j'] });
    expect(resolvePresentationDefaults(stored).nativeKeybindings).toEqual(['shell.palette=cmd-j']);
    expect(presentationSettingSources(stored).nativeKeybindings).toBe('file');
    expect(() => applyPresentationUpdate(stored, { nativeKeybindings: ['shell.palette'] })).toThrow();
    expect(() => applyPresentationUpdate(stored, { nativeKeybindings: ['a=cmd-j', 'a=cmd-k'] })).toThrow();
  });

  it('round-trips through settings.toml and a reset removes entries', () => {
    const written = serializeOperatorDefaultsToml({ nativeKeybindings: ['shell.palette=cmd-j', 'tab.close=alt-q'] });
    expect(parseOperatorDefaultsToml(written).nativeKeybindings).toEqual(['shell.palette=cmd-j', 'tab.close=alt-q']);
    const reset = serializeOperatorDefaultsToml({ nativeKeybindings: ['tab.close=alt-q'] }, written);
    expect(parseOperatorDefaultsToml(reset).nativeKeybindings).toEqual(['tab.close=alt-q']);
  });
});
