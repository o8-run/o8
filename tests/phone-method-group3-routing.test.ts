import { expect, it } from 'vitest';
import { matchNativeHttpRoute, nativeHttpMethods } from '../src/lib/ws-server/native-http-registry';

const methods: Record<string, string[]> = {
  '/api/mobile/action': ['POST'],
  '/api/mobile/diff-comment': ['POST'],
  '/api/mobile/enroll': ['POST'],
  '/api/mobile/live-activity/register': ['DELETE', 'POST'],
  '/api/mobile/live-activity/sync': ['POST'],
  '/api/mobile/orchestrator/threads': ['GET', 'POST'],
  '/api/mobile/ripple/resolve': ['POST'],
  '/api/mobile/terminal-input': ['POST'],
};
it('registers only the live phone method contracts on the existing exact paths', () => {
  for (const [path, verbs] of Object.entries(methods)) {
    expect(nativeHttpMethods(path), path).toEqual(verbs);
    for (const method of verbs) expect(matchNativeHttpRoute(path, method)?.route.path, path).toBe(path);
  }
});
