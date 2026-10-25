import { providerCredentialMaterials } from './key-store';
import { matchesProviderCredential } from './credential-materials';
import { providerCredentialName } from './spawn-environment';

/** Untrusted child diagnostics can echo argv, provider keys or service env. */
export function childDiagnostic(text: string, explicit: Record<string, string | undefined> = {}): string {
  try {
    const materials = providerCredentialMaterials();
    const values = [...materials.values,
      ...Object.entries(process.env).filter(([name]) => providerCredentialName(name)).map(([, value]) => value),
      ...Object.values(explicit)].filter((value): value is string => Boolean(value));
    return matchesProviderCredential(text, { ...materials, values }) ? '[MCP diagnostics withheld]' : text;
  } catch { return '[MCP diagnostics unavailable]'; }
}
