import path from 'node:path';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { childEnvironment } from './spawn-environment';
import { containsProviderCredential } from './credential-materials';
import { providerCredentialMaterials } from './key-store';
import { decodedMcpText } from './decoded-mcp-text';

/** Only a recognized executable selects a payer. Wrappers fail closed. */
export function mcpRuntimeId(command: string): string | undefined {
  const binary = path.win32.basename(path.basename(command)).replace(/\.(exe|cmd|bat)$/i, '');
  return Object.entries(ORCHESTRATOR_RUNTIMES).find(([, runtime]) => runtime.binaryName === binary)?.[0];
}

export function mcpLaunchEnvironment(command: string, env: Record<string, string> = {}) {
  return childEnvironment({ runtimeId: mcpRuntimeId(command), env });
}

export function assertMcpTransport(input: unknown): void {
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && containsProviderCredential(decodedMcpText(value))) {
      throw new Error('MCP configuration contains a saved provider credential. Use runtime API billing instead.');
    }
    if (Array.isArray(value)) { for (const item of value) visit(item); }
    else if (value && typeof value === 'object') { for (const item of Object.values(value)) visit(item); }
  };
  visit(input);
}

/** Apply before truncation, including values that have no recognizable key prefix. */
export function redactMcpOutput(text: string): string {
  let result = text;
  for (const secret of providerCredentialMaterials().values) result = result.split(secret).join('[redacted]');
  return result;
}

/** Scrub after parsing too: JSON escapes may hide a value on the wire. */
export function redactMcpResponse<T>(value: T): T {
  if (typeof value === 'string') return redactMcpOutput(value) as T;
  if (Array.isArray(value)) return value.map(redactMcpResponse) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [redactMcpOutput(key), redactMcpResponse(item)])) as T;
  return value;
}
