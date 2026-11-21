import { expect, it } from 'vitest';
import { deleteMobileLiveActivityToken, hasMobileLiveActivityTokens, upsertMobileLiveActivityToken } from './live-activity-push';

it('reports whether any phone registered a Live Activity', () => {
  expect(hasMobileLiveActivityTokens()).toBe(false);
  upsertMobileLiveActivityToken({ pushToken: 'push-token-1', bundleId: 'run.o8.test', environment: 'sandbox' });
  expect(hasMobileLiveActivityTokens()).toBe(true);
  deleteMobileLiveActivityToken('push-token-1');
  expect(hasMobileLiveActivityTokens()).toBe(false);
});
