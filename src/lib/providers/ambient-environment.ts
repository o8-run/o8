import AMBIENT_NAMES from './ambient-environment-names.json';
import { providerCredentialName } from './credential-names';
/** Ambient inheritance is explicit. Shell hooks, preload flags and arbitrary
 * credentials never become child configuration. Callers add run/service-scoped
 * values explicitly; provider credentials are resolved by the payer policy.
 */
export { default as AMBIENT_NAMES } from './ambient-environment-names.json';

export function ambientChildEnvironment(input: NodeJS.ProcessEnv = process.env): Record<string, string> & Pick<NodeJS.ProcessEnv, 'NODE_ENV'> {
  const mode = input.NODE_ENV;
  return { ...Object.fromEntries(AMBIENT_NAMES.flatMap(name => input[name] === undefined ? [] : [[name, input[name]!]])),
    NODE_ENV: mode === 'development' || mode === 'test' ? mode : 'production' };
}

/** Generic check commands have no runtime payer authority. Explicit service
 * settings survive, but provider slots require a governed runtime launch.
 */
export function unprivilegedChildEnvironment(overrides: Record<string, string | undefined> = {}): ReturnType<typeof ambientChildEnvironment> {
  const env = ambientChildEnvironment();
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined && !providerCredentialName(name) && name !== 'O8_MASTER_KEY') env[name] = value;
  }
  return env;
}
