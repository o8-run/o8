import { describe, expect, it } from 'vitest';
import { orchestratorErrorMessage, orchestratorErrorText } from './orchestrator-error';

const frame = 'file:///bundle/bridge.mjs:2\nError: {void 0;}; throw failure;\n  ^\n\n';

describe('orchestrator error display limits', () => {
  it('keeps a plain server Error message unchanged', () => {
    const error = new Error('Choose a project first.');
    expect(orchestratorErrorText(error.message, 'Failed to send message').replace(/\s+/g, ' '))
      .toBe('Choose a project first.');
  });

  it('uses an exception name and message instead of its source-bearing stack', () => {
    const error = new TypeError('first line\nactual reason');
    error.stack = `${frame}SyntaxError: unrelated stack summary`;
    expect(orchestratorErrorMessage(error)).toBe('TypeError: first line actual reason');
  });

  it('cleans a source-bearing message before adding bridge context', () => {
    const error = new SyntaxError(`${frame}SyntaxError [ERR_INVALID_MODULE_SYNTAX]: invalid import\n    at load (bridge.mjs:2:1)`);
    expect(orchestratorErrorMessage(error, 'initialize'))
      .toBe('SyntaxError [ERR_INVALID_MODULE_SYNTAX]: initialize: invalid import');
    expect(orchestratorErrorMessage(`Error: initialize: ${error.message}`))
      .toBe('SyntaxError [ERR_INVALID_MODULE_SYNTAX]: invalid import');
  });

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

  it.each(['node:internal/modules/run_main:123', 'webpack://bundle/bootstrap:12:3', 'relative-script:4'])('recognizes a non-file frame at %s', location => {
    expect(orchestratorErrorText(`${location}\ntriggerUncaughtException(\n  ^\nactual reason`)).toBe('actual reason');
  });

  it('keeps continuation lines, blank lines and object formatting before the stack', () => {
    const reason = "{\n  reason: 'first line',\n\n  detail: 'second line'\n}";
    expect(orchestratorErrorText(`${frame}${reason}\n    at main (bridge.mjs:2:1)\n\nNode.js v22.23.2`)).toBe(reason);
  });

  it('keeps message lines that only resemble frames', () => {
    const reason = 'Error: first line\n    at something\nlast line with actual reason';
    expect(orchestratorErrorText(`${frame}${reason}\n    at main (bridge.mjs:2:1)`)).toBe(reason);
  });

  it.each(['async', 'new'])('keeps a locationless at %s message line', modifier => {
    const reason = `Error: first line\n    at ${modifier} something\nlast line with actual reason`;
    expect(orchestratorErrorText(`${frame}${reason}\n    at main (bridge.mjs:2:1)`)).toBe(reason);
  });

  it.each(['async', 'new'])('stops at at %s frames with locations', modifier => {
    for (const location of [
      'run (file:///bundle/bridge.mjs:2:1)',
      'file:///bundle/bridge.mjs:2:1',
      'node:internal/modules/run_main',
      '<anonymous>',
      'native',
      'Promise.any (index 0)',
      'Promise.allSettled (index 1)',
      'run (<anonymous>)',
      'run (native)',
      'run (node:internal/modules/run_main)',
    ]) {
      expect(orchestratorErrorText(`Error: actual reason\n    at ${modifier} ${location}`)).toBe('Error: actual reason');
    }
  });

  it.each([
    'at run (file:///bundle/bridge.mjs:2:1)',
    'at file:///bundle/bridge.mjs:2:1',
    'at async Promise.all (index 0)',
    'at Promise.any (index 0)',
    'at async Promise.any (index 0)',
    'at Promise.allSettled (index 1)',
    'at async Promise.allSettled (index 1)',
    'at new Worker (node:internal/worker:1:2)',
    'at <anonymous>',
    'at Array.map (<anonymous>)',
    'at native',
    'at callback (native)',
    'at run (node:internal/modules/run_main)',
    'at node:internal/modules/run_main',
  ])('stops at the V8 frame %s', stackFrame => {
    expect(orchestratorErrorText(`Error: actual reason\n    ${stackFrame}`)).toBe('Error: actual reason');
  });

  it('keeps the contextual bridge summary without repeating the original stack header', () => {
    expect(orchestratorErrorText('Error: initialize: fixture failure\nError: fixture failure\n    at main (bridge.mjs:2:1)'))
      .toBe('Error: initialize: fixture failure');
  });

  it.each(["{ reason: 'object actual reason' }", 'actual reason; retry later'])('preserves an already selected diagnostic: %s', reason => {
    expect(orchestratorErrorText(reason)).toBe(reason);
  });
});
