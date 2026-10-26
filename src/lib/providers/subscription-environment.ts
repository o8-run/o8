/** Subscription children receive system basics and typed, declared service settings only. */
const SYSTEM_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM',
  'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', '__CF_USER_TEXT_ENCODING',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
  'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'NODE_ENV', 'NO_COLOR', 'FORCE_COLOR',
]);
const LABEL = /^[a-z][a-z0-9-]{0,31}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MODES = /^(?:read|write|read-only|read-write|readonly|production|development|test)$/;
const FORMATS = /^(?:json|text|yaml|toml)$/;
const SERVICE_FIELDS: Record<string, RegExp> = {
  region: LABEL, mode: MODES, format: FORMATS, team: LABEL,
  project: LABEL, scope: /^(?:read|write|read-only|read-write|all)$/, host: HOST, user: LABEL,
};

function serviceConfig(value: string): string | undefined {
  if (Buffer.byteLength(value) > 16 * 1024) return;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const fields = Object.entries(parsed).filter(([name, item]) => Object.hasOwn(SERVICE_FIELDS, name)
    && typeof item === 'string' && SERVICE_FIELDS[name].test(item));
  return fields.length ? JSON.stringify(Object.fromEntries(fields)) : undefined;
}

function declaredSetting(name: string, value: string): string | undefined {
  if (name === 'SERVICE_AUTH_CONFIG') return serviceConfig(value);
  // Declaring an env slot does not authorize credentials, arbitrary config, or preload code.
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /(?:KEY|TOKEN|SECRET|AUTH|PASSWORD|PROXY|OPTIONS)/.test(name)) return;
  if (/(?:^|_)(?:ENABLED|DISABLED|FAIL)$/.test(name) || /(?:^|_)(?:DISABLE|ENABLE)_/.test(name)) return /^(?:0|1|true|false)$/.test(value) ? value : undefined;
  if (/(?:^|_)(?:DIR|FILE|PATH)$/.test(name) || name === 'WORKTREE') {
    return /^(?:\/|[A-Za-z]:\\)[A-Za-z0-9_ .\/\\-]{0,4095}$/.test(value) ? value : undefined;
  }
  if (/(?:^|_)PORT$/.test(name)) return /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 65535 ? value : undefined;
  if (/(?:^|_)HOST$/.test(name)) return HOST.test(value) ? value : undefined;
  if (/(?:^|_)MODE$/.test(name)) return MODES.test(value) ? value : undefined;
  if (/(?:^|_)FORMAT$/.test(name)) return FORMATS.test(value) ? value : undefined;
  if (/(?:^|_)(?:NAME|REGION|TEAM|PROJECT|SCOPE|USER|ID)$/.test(name) || name === 'BRANCH') return LABEL.test(value) ? value : undefined;
  return;
}

export function subscriptionEnvironment(input: Record<string, string | undefined>, declared: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SYSTEM_KEYS) if (input[name] !== undefined) env[name] = input[name]!;
  for (const [name, value] of Object.entries(input)) {
    if (/^LC_[A-Z_]+$/.test(name) && value !== undefined && /^[A-Za-z0-9_.@-]{1,80}$/.test(value)) env[name] = value;
  }
  for (const name of declared) {
    const value = input[name];
    if (value === undefined || SYSTEM_KEYS.has(name)) continue;
    const allowed = declaredSetting(name, value);
    if (allowed !== undefined) env[name] = allowed;
  }
  return env;
}
