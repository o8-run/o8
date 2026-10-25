import { withMcpConfigPolicy } from '@/lib/providers/mcp-config-policy';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One Codex orchestrator turn for the app-server bridge (#3573). The bridge runs
 * the turn through `codex app-server` in the operator's own Codex home, so the
 * thread is recorded with an interactive source and appears in the Codex app.
 */
export interface CodexAppBridgeSpec {
  codexBin: string;
  cwd: string;
  /** Resume this Codex thread; null starts a new one. */
  threadId: string | null;
  /** o8's orchestrator prompt. Sent as developer instructions, not as user text. */
  developerInstructions: string | null;
  message: string;
  imagePaths: string[];
  model: string;
  effort: string;
  serviceTier: string | null;
  sandbox: 'read-only' | 'danger-full-access';
  /** Per-thread config overrides, such as o8's MCP servers. */
  config: Record<string, unknown>;
}

/** Marker between o8's prompt and the user's message in buildCodexOrchestratorPrompt. */
export const CODEX_USER_MESSAGE_MARKER = '\n\n## USER MESSAGE\n\n';

/** Keep the complete wrapped turn in developer context when the operator's text is available. */
export function splitCodexOrchestratorPrompt(prompt: string, rawMessage?: string): { instructions: string | null; message: string } {
  // Preserve every instruction and its order, including context after the marker.
  // Do not parse the operator's words: they can contain o8's headings verbatim.
  if (rawMessage !== undefined) return { instructions: prompt, message: rawMessage };
  // Automated continuations have no raw operator text; retain their existing split.
  // The first marker: o8's prompt comes first, and the user's text may contain anything.
  const at = prompt.indexOf(CODEX_USER_MESSAGE_MARKER);
  if (at < 0) return { instructions: null, message: prompt };
  return { instructions: prompt.slice(0, at), message: prompt.slice(at + CODEX_USER_MESSAGE_MARKER.length) };
}

/** The spec carries the prompt, so it goes to a private file that the bridge deletes on read. */
export function writeCodexAppBridgeSpec(spec: CodexAppBridgeSpec, dir = tmpdir()): string {
  const file = join(dir, `o8-codex-app-${randomUUID()}.json`);
  withMcpConfigPolicy(spec.config, 'codex', () => writeFileSync(file, JSON.stringify(spec), { encoding: 'utf8', mode: 0o600 }));
  return file;
}
