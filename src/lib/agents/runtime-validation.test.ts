import { expect, it } from 'vitest';
import { validateRequestedRuntime } from './routing';
it.each(['typo-runtime', 42, {}, false])('strict admission refuses runtime %j', requestedRuntime => {
  expect(() => validateRequestedRuntime(requestedRuntime)).toThrow(/runtime/i);
});
it('strict admission refuses a known unsupported runtime', () => {
  expect(() => validateRequestedRuntime('magnitude')).toThrow(/dispatchable/);
});
