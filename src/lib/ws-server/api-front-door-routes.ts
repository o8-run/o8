import templates from '../../../crates/o8d/route-templates.json';
import { matchNativeHttpRoute } from './native-http-registry';

/** A more specific unregistered Next path must not fall into a dynamic handler. */
export function registeredFrontDoorRoute(pathname: string, method: string): boolean {
  let match: ReturnType<typeof matchNativeHttpRoute>;
  try { match = matchNativeHttpRoute(pathname, method); } catch { return false; }
  if (!match) return false;
  const parts = pathname.split('/');
  const known = templates.filter(pattern => {
    const expected = pattern.split('/');
    return expected.length === parts.length && expected.every((part, i) => part === parts[i] || /^\[\w+\]$/.test(part));
  }).sort((a, b) => b.split('/').filter(p => !p.startsWith('[')).length - a.split('/').filter(p => !p.startsWith('[')).length)[0];
  return !known || known === match.route.path;
}

