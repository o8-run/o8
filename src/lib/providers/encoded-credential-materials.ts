import { parse } from 'smol-toml';
import type { ProviderCredentialMaterials } from './key-store';
import { matchesProviderCredential } from './credential-materials';

const MAX_BYTES = 256 * 1024;
const MAX_NODES = 1024;
const MAX_DEPTH = 16;

/** Inspect supported text encodings without changing an allowed value's bytes. */
export function matchesEncodedProviderCredential(text: string, materials: ProviderCredentialMaterials): boolean {
  const pending: Array<{ value: string; depth: number }> = [];
  const seen = new Set<string>();
  const derived = new Map<string, Set<string>>();
  const groups: Array<{ parent: string; leaves: string[]; depth: number }> = [];
  let bytes = 0, nodes = 0, generation = 0;
  const visit = (depth: number) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('Credential inspection limit exceeded.');
  };
  const add = (value: string, depth: number, parent?: string) => {
    if (parent !== undefined && parent !== value) {
      const children = derived.get(parent) ?? new Set<string>();
      if (!children.has(value)) { children.add(value); generation++; }
      derived.set(parent, children);
    }
    if (seen.has(value)) return;
    visit(depth);
    bytes += Buffer.byteLength(value);
    if (bytes > MAX_BYTES) throw new Error('Credential inspection limit exceeded.');
    seen.add(value); pending.push({ value, depth });
  };
  const base64 = (value: string, depth: number, parent = value) => {
    const compact = value.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/_-]{2,}={0,2}$/.test(compact)) return;
    const normalized = compact.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (normalized.length % 4 === 1 || compact.includes('=') && compact.length % 4 !== 0) return;
    const decoded = Buffer.from(compact, 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== normalized) return;
    // Replacement characters preserve inspectable text within binary wrappers.
    add(decoded.toString('utf8'), depth + 1, parent);
  };
  const structured = (value: unknown, depth: number, parent: string) => {
    const leaves: string[] = [], keys: string[] = [];
    const stack = [{ value, depth }];
    while (stack.length) {
      const item = stack.pop()!;
      visit(item.depth);
      if (typeof item.value === 'string') { leaves.push(item.value); add(item.value, item.depth, parent); }
      else if (Array.isArray(item.value)) {
        for (let i = item.value.length - 1; i >= 0; i--) stack.push({ value: item.value[i], depth: item.depth + 1 });
      } else if (item.value && typeof item.value === 'object') {
        const entries = Object.entries(item.value);
        for (const [key] of entries) { keys.push(key); add(key, item.depth + 1); }
        for (let i = entries.length - 1; i >= 0; i--) {
          const [, child] = entries[i];
          stack.push({ value: child, depth: item.depth + 1 });
        }
      }
    }
    add(leaves.join(''), depth, parent); add(keys.join(''), depth);
    for (const values of [leaves, keys]) {
      const nonempty = values.filter(Boolean);
      if (nonempty.length > 1) groups.push({ parent, leaves: nonempty, depth });
    }
  };
  const joinVariants = () => {
    for (const group of groups) {
      let combinations = [''];
      for (const leaf of group.leaves) {
        const variants = new Set<string>(), stack = [leaf];
        while (stack.length) {
          const variant = stack.pop()!;
          if (variants.has(variant)) continue;
          visit(group.depth); variants.add(variant);
          stack.push(...derived.get(variant) ?? []);
        }
        const joined = new Set<string>();
        for (const prefix of combinations) for (const variant of variants) {
          visit(group.depth);
          const candidate = prefix + variant;
          bytes += Buffer.byteLength(candidate);
          if (bytes > MAX_BYTES) throw new Error('Credential inspection limit exceeded.');
          joined.add(candidate);
        }
        combinations = [...joined];
      }
      for (const value of combinations) add(value, group.depth, group.parent);
    }
  };
  try {
    add(text, 0);
    let index = 0;
    for (;;) {
      for (; index < pending.length; index++) {
        const { value, depth } = pending[index];
        if (matchesProviderCredential(value, materials)) return true;
        add(value.replace(/(?:%[0-9a-f]{2})+/gi,
          part => Buffer.from(part.replace(/%/g, ''), 'hex').toString('utf8')), depth + 1, value);
        add(value.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), depth + 1, value);
        let parsed: unknown;
        try { parsed = JSON.parse(value); }
        catch { try { parsed = parse(value); } catch { /* Ordinary service value. */ } }
        if (parsed !== undefined) structured(parsed, depth + 1, value);
        let url: URL | undefined;
        try { url = new URL(value); } catch { /* Not a URL. */ }
        if (url) {
          structured([url.username, url.password, url.pathname, url.hash, ...url.searchParams.values()], depth + 1, value);
          structured([...url.searchParams.keys()], depth + 1, value);
        }
        base64(value, depth);
        for (const match of value.matchAll(/[A-Za-z0-9+/_-]{2,}={0,2}/g)) base64(match[0], depth, value);
      }
      const beforeJoins = generation;
      joinVariants();
      if (index === pending.length && generation === beforeJoins) break;
    }
    return false;
  } catch {
    // Incomplete inspection must never authorize the original opaque value.
    return true;
  }
}
