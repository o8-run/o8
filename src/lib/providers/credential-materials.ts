import { createHash } from 'node:crypto';
import { providerCredentialMaterials, type ProviderCredentialMaterials } from './key-store';

const historicalHashes = new WeakMap<ProviderCredentialMaterials, ReadonlySet<string>>();

/** Decode carriers, not just whole strings: launch options often embed a URL or
 * TOML value. Bounds fail closed rather than allowing another encoding layer.
 */
function* credentialCandidates(value: string): Generator<string> {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<string>();
  let bytes = 0;
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index];
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    bytes += current.value.length;
    if (bytes > 16 * 1024 * 1024 || seen.size > 4096) throw new Error('Credential carrier exceeds validation limits.');
    yield current.value;
    const decoded = new Set<string>();
    // Decode valid escape runs independently so malformed adjacent text cannot
    // suppress a valid encoded key elsewhere in the same argument.
    decoded.add(current.value.replace(/(?:%[a-f\d]{2})+/gi, part => Buffer.from(part.replaceAll('%', ''), 'hex').toString('utf8')));
    const tokens = current.value.match(/[a-z\d+/_-]{8,}={0,2}/gi) ?? [];
    for (const token of tokens) {
      // A surrounding URL/path/header prefix can itself use Base64 characters.
      // Check every quartet alignment; binary prefix/suffix bytes must not hide
      // a UTF-8 credential or prevent decoding another nested carrier.
      for (let offset = 0; offset < 4; offset++) decoded.add(Buffer.from(token.slice(offset), 'base64url').toString('utf8'));
    }
    for (const text of decoded) if (text && text !== current.value && !seen.has(text)) {
      if (current.depth >= 16) throw new Error('Credential carrier exceeds validation limits.');
      pending.push({ value: text, depth: current.depth + 1 });
    }
  }
}

/** Field-independent matching of current and retired provider material. */
export function matchesProviderCredential(value: string, materials: ProviderCredentialMaterials): boolean {
  let hashes = historicalHashes.get(materials);
  if (!hashes) {
    const remaining = new Set(materials.hashes);
    for (const secret of materials.values) remaining.delete(createHash('sha256').update(secret).digest('hex'));
    hashes = remaining; historicalHashes.set(materials, hashes);
  }
  if (!hashes.size && !materials.values.length) return false;
  for (const candidate of credentialCandidates(value)) {
    if (materials.values.some(secret => candidate.includes(secret))) return true;
    if (!hashes.size) continue;
    const bytes = Buffer.from(candidate);
    for (const length of materials.lengths) for (let offset = 0; offset + length <= bytes.length; offset++) {
      if (hashes.has(createHash('sha256').update(bytes.subarray(offset, offset + length)).digest('hex'))) return true;
    }
  }
  return false;
}

/** Allowed values are explicit provider slots already authorized by the launch policy. */
export function containsProviderCredential(value: string, allowed: ReadonlySet<string> = new Set()): boolean {
  const materials = providerCredentialMaterials();
  if (!allowed.size) return matchesProviderCredential(value, materials);
  const hashes = new Set(materials.hashes);
  for (const secret of allowed) hashes.delete(createHash('sha256').update(secret).digest('hex'));
  return matchesProviderCredential(value, { ...materials, hashes, values: materials.values.filter(secret => !allowed.has(secret)) });
}
