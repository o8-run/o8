import { expect, it } from 'vitest';
import { matchNativeHttpRoute, nativeHttpMethods } from '../src/lib/ws-server/native-http-registry';

const routes = [
  '/api/mobile/genui/stream', '/api/mobile/pairing-discovery', '/api/mobile/pull-requests',
  '/api/mobile/search', '/api/mobile/usage', '/api/panel/search',
  '/api/setup/orchestrator-backends', '/api/worktrees/diff-summary',
];
it('registers the remaining live phone GET paths on their existing handlers', () => {
  for (const path of routes) {
    expect(matchNativeHttpRoute(path, 'GET')?.route.path, path).toBe(path);
    expect(nativeHttpMethods(path), path).toContain('GET');
  }
});

it('preserves the phone Ask and automation POST contracts', () => {
  expect(nativeHttpMethods('/api/mobile/genui/stream')).toEqual(['GET', 'POST']);
  for (const suffix of ['enabled', 'run']) {
    const path = '/api/mobile/automations/phone-fixture/' + suffix;
    expect(matchNativeHttpRoute(path, 'POST')?.route.path).toBe('/api/mobile/automations/[id]/' + suffix);
    expect(nativeHttpMethods(path)).toEqual(['POST']);
  }
});
