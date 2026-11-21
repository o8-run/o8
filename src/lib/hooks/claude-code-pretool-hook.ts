// ⚠️ SYNC-BY-HAND: this hook ships TWICE — this src .ts (run via `npx tsx`
// in dev / fresh clones, before dist/ is built) and the hand-maintained
// dist/hooks/claude-code-pretool-hook.js (run via node in built/prod installs).
// install-hooks.ts picks the .js when it exists, else this .ts. There is NO
// build step that generates the .js from this file — they are kept in sync by
// hand. Mirror EVERY logic change in both, or dev and prod behave differently.
import process from 'node:process';
import { DEFAULT_API_PORT } from '@/lib/panel/api-port';

interface PreToolUseHookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

interface PreToolUseHookOutput {
  decision: 'approve' | 'block' | 'ask_user';
  reason?: string;
}

function readStdin() {
  return new Promise<string>((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractCommand(input: Record<string, unknown>) {
  const candidates = [
    input.command,
    input.cmd,
    input.input,
    input.text,
    input.script,
  ];
  return candidates.map(normalizeString).find(Boolean) ?? '';
}

function extractFilePath(input: Record<string, unknown>) {
  const candidates = [
    input.file_path,
    input.path,
    input.target_path,
    input.filePath,
  ];
  return candidates.map(normalizeString).find(Boolean) ?? '';
}

function isProtectedPath(filePath: string) {
  const normalized = filePath.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes('/.git/') || normalized.endsWith('/.git')) {
    return true;
  }
  const fileName = normalized.split('/').pop() ?? normalized;
  return fileName.includes('.env')
    || fileName.includes('credentials')
    || fileName.includes('secret')
    || fileName.includes('token');
}

function evaluateToolUse(input: PreToolUseHookInput): PreToolUseHookOutput {
  if (input.tool_name === 'Bash') {
    const command = extractCommand(input.tool_input);
    const destructivePattern = /(^|[;&|]\s*)(rm\b|kill\b|pkill\b|truncate\b|mkfs\b|fdisk\b|diskutil\s+eraseDisk\b|format\b|dd\b|dropdb\b|drop\s+table\b)/i;
    if (destructivePattern.test(command)) {
      return {
        decision: 'block',
        reason: 'Destructive command blocked by o8 policy',
      };
    }
    if (/\bgit\s+reset\s+--hard\b/i.test(command)) {
      return {
        decision: 'block',
        reason: 'git reset --hard blocked — use git stash or git checkout <file> instead',
      };
    }
    if (/\bgit\s+clean\s+-[a-z]*f/i.test(command)) {
      return {
        decision: 'block',
        reason: 'git clean -f blocked — removes untracked files permanently',
      };
    }
    if (/\bgit\s+checkout\s+\.\s*$/i.test(command)) {
      return {
        decision: 'block',
        reason: 'git checkout . blocked — discards all unstaged changes',
      };
    }
    if (/\bgit\s+push\b/i.test(command) && /(?:--force|-f)(?:\s|$)/i.test(command)) {
      return {
        decision: 'block',
        reason: 'Force push blocked by o8 policy — never force push',
      };
    }
    if (/\bgit\s+(?:push|merge|rebase)\b/i.test(command)) {
      return {
        decision: 'ask_user',
        reason: 'Git push/merge/rebase requires confirmation',
      };
    }
  }

  if (input.tool_name === 'FileWrite'
    || input.tool_name === 'FileEdit'
    || input.tool_name === 'Write'
    || input.tool_name === 'Edit'
    || input.tool_name === 'MultiEdit') {
    const filePath = extractFilePath(input.tool_input);
    if (isProtectedPath(filePath)) {
      return {
        decision: 'block',
        reason: 'Protected file path blocked by o8 policy',
      };
    }
  }

  return { decision: 'approve' };
}

function approvalEndpoint() {
  const host = process.env.O8_API_HOST || 'localhost';
  const port = process.env.O8_API_PORT || process.env.PORT || String(DEFAULT_API_PORT);
  return `http://${host}:${port}/api/panel/approvals`;
}

async function createApproval(input: PreToolUseHookInput, outcome: PreToolUseHookOutput) {
  if (!outcome.reason) {
    return;
  }

  const command = input.tool_name === 'Bash' ? extractCommand(input.tool_input) : undefined;
  const filePath = extractFilePath(input.tool_input) || undefined;
  const risk = outcome.decision === 'block' ? 'high' : 'medium';

  await fetch(approvalEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create',
      approval: {
        source: 'runtime',
        runtime: 'claude-code',
        agent: 'Claude Code Hook',
        sessionKey: `claude-code:${input.session_id}`,
        title: outcome.decision === 'block' ? 'Blocked Claude Code tool use' : 'Claude Code tool requires confirmation',
        description: outcome.reason,
        summary: command
          ? `${input.tool_name}: ${command}`
          : `${input.tool_name}${filePath ? `: ${filePath}` : ''}`,
        toolName: input.tool_name,
        args: input.tool_input,
        command,
        editable: false,
        risk,
        metadata: {
          Session: input.session_id,
          Tool: input.tool_name,
          ToolUseId: input.tool_use_id,
          ...(filePath ? { Path: filePath } : {}),
        },
      },
    }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => undefined);
}

function toHookPayload(output: PreToolUseHookOutput) {
  const permissionDecision = output.decision === 'approve'
    ? 'allow'
    : output.decision === 'ask_user'
      ? 'ask'
      : 'deny';

  return {
    decision: output.decision,
    reason: output.reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
    },
    systemMessage: output.reason,
  };
}

async function main() {
  let parsed: PreToolUseHookInput | null = null;

  try {
    const raw = await readStdin();
    parsed = JSON.parse(raw) as PreToolUseHookInput;
  } catch {
    const fallback = toHookPayload({ decision: 'approve' });
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
    process.exit(0);
    return;
  }

  // Distinguish o8-spawned autonomous agents from the operator's own paired
  // Claude Code session. o8 sets O8_MANAGED_SESSION=1 on every spawn
  // (orchestrator, claude-code adapter, auto-compact
  // route); an operator running `claude` directly in their terminal does
  // not have this env var.
  //
  // Hard-safety blocks apply everywhere — they protect the user from AI
  // mistakes even when they've disabled Claude Code's own permission
  // prompts. Ask_user + panel approval rows only make sense for managed
  // agents; for a paired session, Claude Code's own permission system
  // already handles confirmation, so routing through o8 is redundant.
  const isManagedSession = process.env.O8_MANAGED_SESSION === '1';
  // The operator's paired session is fully trusted — they opted out of the
  // hard-safety guard ("remove that hook, I trust you", 2026-05-21). Only
  // o8-managed autonomous agents are evaluated + routed to the approval
  // surface; the paired session approves everything and relies on Claude
  // Code's own permission system + the operator's oversight.
  const outcome: PreToolUseHookOutput = isManagedSession ? evaluateToolUse(parsed) : { decision: 'approve' };

  if (!isManagedSession && outcome.decision === 'ask_user') {
    const payload = `${JSON.stringify(toHookPayload({ decision: 'approve' }))}\n`;
    process.stdout.write(payload);
    process.exit(0);
    return;
  }

  if (outcome.decision === 'block' && isManagedSession) {
    await createApproval(parsed, outcome);
  }

  const payload = `${JSON.stringify(toHookPayload(outcome))}\n`;
  process.stdout.write(payload);
  if (outcome.decision === 'block') {
    process.stderr.write(payload);
    process.exit(2);
    return;
  }
  process.exit(0);
}

void main();
