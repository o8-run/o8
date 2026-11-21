import { expect, it } from 'vitest';

import { viewerHttpRoutes } from '@/lib/viewers/http-routes';
import { matchNativeHttpRoute, nativeHttpMethods, nativeSurfaceRoutes } from './native-http-registry';

/** The per-request matcher this replaced, kept as the reference. */
function referenceParameters(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index++) {
    const key = expected[index].match(/^\[(\w+)\]$/)?.[1];
    if (key && actual[index]) params[key] = decodeURIComponent(actual[index]);
    else if (expected[index] !== actual[index]) return null;
  }
  return params;
}

const known = [...Object.values(nativeSurfaceRoutes).flat(), ...viewerHttpRoutes];

it('matches every registered route with the same route and parameters as the per-request matcher', () => {
  expect(known.length).toBeGreaterThan(100);
  for (const route of known) {
    const concrete = route.path.replace(/\[(\w+)\]/g, (_, name: string) => `${name}%20value`);
    for (const method of route.methods) {
      const match = matchNativeHttpRoute(concrete, method);
      expect(match, `${method} ${route.path}`).toBeDefined();
      // First registered match wins; it must be one the reference accepts, with its parameters.
      expect(match!.route.methods).toContain(method);
      expect(match!.params).toEqual(referenceParameters(match!.route.path, concrete));
    }
    expect(nativeHttpMethods(concrete)).toEqual(expect.arrayContaining(route.methods));
  }
});

it('rejects a different segment count and an empty parameter segment', () => {
  const parameterized = known.find((route) => /\/\[\w+\]$/.test(route.path));
  expect(parameterized).toBeDefined();
  const base = parameterized!.path.replace(/\/\[\w+\]$/, '');
  expect(matchNativeHttpRoute(`${parameterized!.path.replace(/\[(\w+)\]/g, 'x')}/extra/deeper/than/any`)).toBeUndefined();
  const empty = matchNativeHttpRoute(`${base}/`);
  if (empty) expect(empty.route.path).not.toBe(parameterized!.path);
  expect(matchNativeHttpRoute('/no/such/route/here')).toBeUndefined();
});
