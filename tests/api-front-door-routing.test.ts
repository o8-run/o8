import { describe, expect, it } from 'vitest';
import { apiFrontDoorEnabled } from '../src/lib/ws-server/api-front-door-config';
import { registeredFrontDoorRoute } from '../src/lib/ws-server/api-front-door-routes';

describe('launcher-controlled API takeover', () => {
  it('requires an explicit launcher flag and leaves next dev and release defaults alone', () => {
    for (const NODE_ENV of ['development', 'production', 'test']) {
      expect(apiFrontDoorEnabled({ NODE_ENV })).toBe(false);
      expect(apiFrontDoorEnabled({ NODE_ENV, O8_API_FRONT_DOOR: '0' })).toBe(false);
      expect(apiFrontDoorEnabled({ NODE_ENV, O8_API_FRONT_DOOR: '1' })).toBe(true);
    }
  });

  it('keeps unregistered methods and more-specific Next paths on their original owner', () => {
    expect(registeredFrontDoorRoute('/api/setup/identity', 'GET')).toBe(true);
    expect(registeredFrontDoorRoute('/api/setup/identity', 'POST')).toBe(false);
    expect(registeredFrontDoorRoute('/api/lanes/reap', 'GET')).toBe(false);
    expect(registeredFrontDoorRoute('/api/prompt-library/import', 'GET')).toBe(false);
    expect(registeredFrontDoorRoute('/api/automations/connected', 'PUT')).toBe(false);
    expect(registeredFrontDoorRoute('/api/lanes/%FF', 'GET')).toBe(false);
    expect(registeredFrontDoorRoute('/api/fixture/unknown', 'GET')).toBe(false);
  });
});
