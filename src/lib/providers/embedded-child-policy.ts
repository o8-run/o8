import { PROVIDER_ENV_KEYS, PROVIDER_KEY_ALIASES } from './key-store';
/** Shared by generated Node helpers that can create a child after asynchronous work. */
export const EMBEDDED_CHILD_POLICY_SCRIPT = String.raw`
// o8 embedded child credential boundary
function withO8ChildPolicy(create, options = {}) {
  const policyFs = require('node:fs');
  const policyPath = require('node:path');
  const rawPolicy = process.env.O8_CHILD_CREDENTIAL_POLICY;
  const env = { ...(options.env || process.env) };
  const credentialNames = ${JSON.stringify([...PROVIDER_ENV_KEYS, ...Object.values(PROVIDER_KEY_ALIASES).flat(), 'LLM_API_KEY', 'GOOSE_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN', 'O8_FABLE_ANTHROPIC_API_KEY'])};
  const credentialName = name => credentialNames.includes(name);
  const carriesCredentials = Object.entries({ ...process.env, ...env })
    .some(([name, value]) => credentialName(name) && typeof value === 'string' && value.trim());
  delete env.O8_CHILD_CREDENTIAL_POLICY;
  delete env.O8_MASTER_KEY;
  if (!rawPolicy) {
    if (carriesCredentials) throw new Error('Child credential policy is missing. Retry the launch.');
    return create(env);
  }
  const policy = JSON.parse(rawPolicy);
  if (!policy || typeof policy !== 'object' || typeof policy.runtimeId !== 'string'
    || !/^[a-z0-9][a-z0-9-]*$/.test(policy.runtimeId)
    || typeof policy.directory !== 'string' || !policyPath.isAbsolute(policy.directory)
    || typeof policy.sqliteModule !== 'string' || !policyPath.isAbsolute(policy.sqliteModule)
    || typeof policy.policyFile !== 'string' || !policyPath.isAbsolute(policy.policyFile)
    || typeof policy.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(policy.policyHash)
    || typeof policy.apiAllowed !== 'boolean' || !policy.approvedCredentials || typeof policy.approvedCredentials !== 'object') {
    throw new Error('Child credential policy is invalid. Retry the launch.');
  }
  const hashFile = file => {
    try { return require('node:crypto').createHash('sha256').update(policyFs.readFileSync(file)).digest('hex'); }
    catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
  };
  const Database = require(policy.sqliteModule);
  // Match the parent store boundary's bounded acquisition wait. The empty lock
  // database needs no journal-mode change, which can itself fail under contention.
  const lock = new Database(policyPath.join(policy.directory, '.provider-keys.lock'), { timeout: 1000 });
  try {
    lock.exec('BEGIN EXCLUSIVE');
    if (hashFile(policy.policyFile) !== policy.policyHash) throw new Error('Child credential policy changed. Retry the launch.');
    for (const [name, value] of Object.entries({ ...process.env, ...env })) {
      if (credentialName(name) && typeof value === 'string' && value.trim()
        && require('node:crypto').createHash('sha256').update(value).digest('hex') !== policy.approvedCredentials[name]) {
        throw new Error('Child credential policy does not authorize this credential.');
      }
    }
    if (options.preserveStamp) env.O8_CHILD_CREDENTIAL_POLICY = rawPolicy;
    // Keep validation and the actual OS process creation in one synchronous turn.
    return create(env);
  } finally { lock.close(); }
}
`;
