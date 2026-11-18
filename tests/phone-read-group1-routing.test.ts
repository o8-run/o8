import { expect, it } from 'vitest';
import { matchNativeHttpRoute, nativeHttpMethods } from '../src/lib/ws-server/native-http-registry';

// Live callers in o8-mobile cd7365c5; no absent-caller /mobile/agents or /ws-token.
const routes = [
  '/api/mobile/activity', '/api/mobile/automations', '/api/mobile/diff-comments',
  '/api/mobile/files/content', '/api/mobile/files/list', '/api/mobile/orchestrator/models',
  '/api/mobile/orchestrator/openclaw-agents', '/api/mobile/orchestrator/openclaw-availability',
  '/api/mobile/orchestrator/packets', '/api/mobile/usage/history',
];
it('registers exact live phone GET contracts without capturing another method or path', () => {
  for (const path of routes) {
    expect(matchNativeHttpRoute(path, 'GET')?.route.path, path).toBe(path);
    expect(nativeHttpMethods(path), path).toEqual(['GET']);
    expect(matchNativeHttpRoute(path + '/unknown', 'GET'), path).toBeUndefined();
  }
});
