/**
 * freedesktop Secret Service (GNOME Keyring, KWallet's bridge, KeePassXC) via
 * libsecret's `secret-tool`, the Linux counterpart of the macOS `security` CLI
 * used elsewhere. Secrets travel over stdin; argv carries only attributes.
 *
 * Results distinguish "no such item" from "no Secret Service" (no session bus,
 * no keyring daemon, secret-tool not installed) and from a running service
 * that failed the call (locked collection, dismissed prompt, timeout). Callers
 * may fall back only on `unavailable`.
 */
import { execSecretToolSync, runSecretTool, type SecretToolResult } from './child-process';

export type SecretAttributes = Readonly<Record<string, string>>;

export type SecretLookup =
  | { status: 'found'; value: string }
  | { status: 'absent' }
  | { status: 'unavailable'; detail: string }
  | { status: 'error'; detail: string };

export type SecretWrite =
  | { status: 'ok' }
  | { status: 'unavailable'; detail: string }
  | { status: 'error'; detail: string };

// libdbus / GDBus wording for "nothing to talk to".
const UNAVAILABLE = /autolaunch|not provided by any \.service files|ServiceUnknown|NoServer|Could not connect|Failed to connect|Connection refused|No such file or directory|ENOENT/i;

function detail(result: SecretToolResult): string {
  return result.stderr.replace(/^secret-tool:\s*/, '').trim().slice(0, 300) || `exit ${result.code}`;
}

/** Classify one secret-tool exit. Exported for tests. */
export function classifySecretTool(result: SecretToolResult): SecretLookup {
  if (result.missing) return { status: 'unavailable', detail: detail(result) };
  if (result.code === 0) return { status: 'found', value: result.stdout };
  if (result.code === null) return { status: 'error', detail: detail(result) || 'secret-tool timed out' };
  if (!result.stderr.trim() && !result.stdout) return { status: 'absent' };
  return UNAVAILABLE.test(result.stderr) ? { status: 'unavailable', detail: detail(result) } : { status: 'error', detail: detail(result) };
}

function toWrite(lookup: SecretLookup): SecretWrite {
  return lookup.status === 'found' ? { status: 'ok' }
    : lookup.status === 'absent' ? { status: 'error', detail: 'secret-tool reported no item' }
      : lookup;
}

function attributeArgs(attributes: SecretAttributes): string[] {
  return Object.entries(attributes).flat();
}

export function lookupSecretSync(attributes: SecretAttributes): SecretLookup {
  return classifySecretTool(execSecretToolSync(['lookup', ...attributeArgs(attributes)]));
}

/** Store, then read back. `ok` only when the service returns the same value. */
export function storeSecretSync(label: string, attributes: SecretAttributes, value: string): SecretWrite {
  const stored = toWrite(classifySecretTool(execSecretToolSync(['store', `--label=${label}`, ...attributeArgs(attributes)], value)));
  if (stored.status !== 'ok') return stored;
  const read = lookupSecretSync(attributes);
  return read.status === 'found' && read.value === value ? stored : { status: 'error', detail: 'Secret Service read-back did not match' };
}

export async function lookupSecret(attributes: SecretAttributes): Promise<SecretLookup> {
  return classifySecretTool(await runSecretTool(['lookup', ...attributeArgs(attributes)]));
}

export async function storeSecret(label: string, attributes: SecretAttributes, value: string): Promise<SecretWrite> {
  return toWrite(classifySecretTool(await runSecretTool(['store', `--label=${label}`, ...attributeArgs(attributes)], value)));
}

/** Deleting an item that does not exist succeeds. */
export async function clearSecret(attributes: SecretAttributes): Promise<SecretWrite> {
  const result = classifySecretTool(await runSecretTool(['clear', ...attributeArgs(attributes)]));
  return result.status === 'absent' ? { status: 'ok' } : toWrite(result);
}
