import { describe, expect, it } from 'vitest';

import { runtimeForCommand } from './registry';

describe('runtime process command detection', () => {
  it('recognizes the OpenCode 2 binary and keeps the legacy name compatible', () => {
    expect(runtimeForCommand('/usr/local/bin/opencode2 run task')).toBe('opencode');
    expect(runtimeForCommand('/usr/local/bin/opencode run task')).toBe('opencode');
  });

  it('recognizes 3code directly and through a JavaScript runtime wrapper', () => {
    expect(runtimeForCommand('/usr/local/bin/3code fix the bug')).toBe('3code');
    expect(runtimeForCommand('node /usr/local/bin/3code fix the bug')).toBe('3code');
  });

  it('recognizes catalog-driven Copilot CLI and Crush processes', () => {
    expect(runtimeForCommand('/usr/local/bin/copilot -p task')).toBe('copilot-cli');
    expect(runtimeForCommand('/usr/local/bin/crush run task')).toBe('crush');
  });
});
