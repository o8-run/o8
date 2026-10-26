import { createHash } from 'node:crypto';
import { PLUGIN_PREPARE_TASK_SCOPE, type PluginPrincipal } from '@/lib/auth/plugin-token';
import { withTaskDraftAccountAdmission } from './task-draft-account';
import { canonical } from './task-draft-contract';
import { invalidateTaskDraftSnapshots } from './task-draft-store';
import { TASK_DRAFT_TOOLS } from './task-draft-tools';
import { PLUGIN_TOOLS } from './plugin-tools';

const tools = [...PLUGIN_TOOLS, ...TASK_DRAFT_TOOLS];

/** Bind preparation to the complete reviewed schemas and descriptions. */
export function pluginCatalogRevision(): string {
  return createHash('sha256').update(canonical(tools)).digest('hex');
}

export async function discoverPluginCatalog(principal: PluginPrincipal) {
  const catalogRevision = pluginCatalogRevision();
  const visible = tools.filter((tool) => tool.securitySchemes.every((scheme) =>
    scheme.scopes.every((scope) => principal.scopes.includes(scope))));
  const result = (preparationSnapshotsInvalidated: number) => ({
    tools: visible, catalogRevision, preparationSnapshotsInvalidated,
  });
  if (!principal.scopes.includes(PLUGIN_PREPARE_TASK_SCOPE)) return result(0);
  return withTaskDraftAccountAdmission(principal, undefined, (account) => result(
    invalidateTaskDraftSnapshots(account, principal, catalogRevision),
  ));
}
