import { describe, expect, it } from 'vitest';
import { orchestratorErrorText } from './orchestrator-error';

const frame = 'file:///bundle/bridge.mjs:2\nError: {void 0;}; throw failure;\n  ^\n\n';

describe('orchestrator error display limits', () => {
  it.each([1, 20, 80, 500, 2000])('selects the error before a %i-character cut', limit => {
    const error = 'TypeError [ERR_INVALID_ARG_TYPE]: invalid input (turn/start)';
    expect(orchestratorErrorText(frame + error + '\n    at main (bridge.mjs:2:1)').slice(0, limit)).toBe(error.slice(0, limit));
  });

  it.each([frame, frame.slice(0, 30), 'const bundledSource = 1;', '    at main (bridge.mjs:2:1)'])('uses a readable fallback for incomplete diagnostics: %s', diagnostic => {
    expect(orchestratorErrorText(diagnostic, 'Error: Bridge exited during startup')).toBe('Error: Bridge exited during startup');
  });

  it('removes terminal colors from the failure line', () => {
    expect(orchestratorErrorText(frame + '\u001b[31mTypeError: invalid input\u001b[39m')).toBe('TypeError: invalid input');
  });
});
