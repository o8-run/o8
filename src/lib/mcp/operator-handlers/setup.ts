import { McpInputError } from '@/lib/mcp/api-error';
import { apiFetch, errorText, jsonResult, textResult, type McpTool, type McpToolResult } from './shared';

export const SETUP_TOOLS: McpTool[] = [{
  name: 'o8_setup',
  description: 'Help the operator set up o8. status is read-only and separates installation, credential evidence, provider acceptance, saved choices, and incomplete steps. configure saves lead/worker choices through onboarding validation; workers[0] is the default. open registers an absolute project path without a folder dialog and asks visible onboarding to open it. Read status until the app reports opened or a handoff; pending is not completion. cancel requires the current requestId and never removes a repo or saved choices. Never grant OS permissions for the user; sign-in and permissions are human handoffs.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'configure', 'open', 'cancel'] },
      path: { type: 'string', description: 'Absolute existing project folder; open only.' },
      orchestratorRuntime: { type: 'string', description: 'Available lead runtime from status; Claude is claude-code.' },
      workerRuntimes: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Available worker pool; first entry is the default worker.' },
      leadModel: { type: 'string', description: 'Role-specific model. Codex and Fable use their preset; Claude and OpenCode can save a lead model.' },
      workerModel: { type: 'string', description: 'Model for the default worker runtime.' },
      requestId: { type: 'string', description: 'Receipt id for cancel, or retry open with its previous receipt id to avoid reopening.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
}];

export async function handleSetup(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    if (!['status', 'configure', 'open', 'cancel'].includes(String(args.action))) throw new McpInputError('Use status, configure, open, or cancel.');
    if (args.action === 'status' && Object.keys(args).some((key) => key !== 'action')) throw new McpInputError('status takes no mutation fields.');
    return jsonResult(await apiFetch('/api/setup/agent', args.action === 'status' ? undefined : { method: 'POST', body: JSON.stringify(args) }));
  } catch (error) { return textResult(`o8_setup failed: ${errorText(error)}`, true); }
}
