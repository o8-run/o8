import { childEnvironment } from '@/lib/providers/spawn-environment';
import { knowledgeSourceWriteRefusal } from '@/lib/cortex/knowledge/sources';
export const dynamic = 'force-dynamic';

import { spawn } from '@/lib/providers/child-process';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
import { NextResponse } from 'next/server';

import { formatMissingCliError } from '@/lib/runtimes/shared/cli-unavailable';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { spawnsViaInterpreter } from '@/lib/runtimes/shared/cli-spawn';
import { CODEX_MODEL_IDS, MODEL_IDS } from '@/lib/models';
import { CODEX_SOL_FALLBACK_MODEL, CODEX_SOL_UPDATE_NOTICE, isCodexSolUnsupported } from '@/lib/codex/model-compatibility';
import { EFFORT_CHOICE_LIST, resolveEffortPin } from '@/lib/orchestrator/effort-pin';
import { resolveCodexLaunchContext } from '@/lib/codex/launch-context';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';

/**
 * POST /api/v2/proxy/cli
 *
 * Routes chat messages through an installed CLI runtime (Claude Code, Codex, Gemini CLI)
 * instead of a provider API. Spawns the CLI as a subprocess, pipes the prompt,
 * and streams the output back as SSE events matching our existing stream format.
 */

type CliRuntime = 'claude-code' | 'codex' | 'gemini' | 'opencode';

interface CliRequestBody {
  runtime: CliRuntime;
  model: string;       // e.g. 'cli:claude-code:opus' → extract 'opus' or 'haiku'
  messages: { role: string; content: string }[];
  effort?: unknown;
  repoPath?: string;
}

/** How much runtime stderr rides along in a silent-exit explanation. */
const STDERR_TAIL_CHARS = 600;

/**
 * Explain a runtime that closed without answering. The common cause is a cwd the CLI
 * refuses to run in ("Not inside a trusted directory"), which is invisible without the
 * stderr tail.
 */
function describeSilentExit(input: {
  label: string;
  code: number | null;
  cwd: string;
  stderrTail: string;
  producedOutput: boolean;
}): string {
  const exit = typeof input.code === 'number' ? `exit code ${input.code}` : 'no exit code';
  const head = input.producedOutput
    ? `${input.label} failed partway through (${exit}) in ${input.cwd}.`
    : `${input.label} exited without a response (${exit}) in ${input.cwd}.`;
  return input.stderrTail.trim() ? `${head}\n${input.stderrTail.trim()}` : head;
}

const CODEX_MODEL_MAP: Record<string, string> = {
  ...Object.fromEntries(CODEX_MODEL_IDS.map((id) => [id, id])),
  'o4-mini': 'o4-mini',
};

const GEMINI_MODEL_MAP: Record<string, string> = {
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
};

function extractModelKey(cliModelId: string): string {
  // cli:claude-code:opus → opus
  const parts = cliModelId.split(':');
  return parts[parts.length - 1];
}

function buildPrompt(messages: { role: string; content: string }[]): string {
  // Take the last user message as the prompt
  const userMessages = messages.filter((m) => m.role === 'user');
  const lastUser = userMessages[userMessages.length - 1];
  if (!lastUser) return '';

  // Include recent context (last few assistant messages for continuity)
  const recent = messages.slice(-6);
  const contextParts: string[] = [];
  for (const m of recent) {
    if (m === lastUser) break;
    if (m.role === 'assistant') {
      contextParts.push(`Previous assistant response: ${m.content.slice(0, 500)}`);
    }
  }

  if (contextParts.length > 0) {
    return `${contextParts.join('\n')}\n\nUser: ${lastUser.content}`;
  }
  return lastUser.content;
}

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as CliRequestBody | null;
    if (!body?.runtime || !body?.model || !Array.isArray(body?.messages)) {
      return NextResponse.json({ error: 'runtime, model, and messages are required' }, { status: 400 });
    }

    const { runtime, model, messages, repoPath } = body;
    const sourceRefusal = knowledgeSourceWriteRefusal(repoPath);
    if (sourceRefusal) return sourceRefusal;
    const modelKey = extractModelKey(model);
    const prompt = buildPrompt(messages);
    if (!prompt) {
      return NextResponse.json({ error: 'No user message found' }, { status: 400 });
    }
    if (body.effort !== undefined && !isThinkingEffort(body.effort)) {
      return NextResponse.json({
        error: `effort must be one of: ${EFFORT_CHOICE_LIST}.`, code: 'invalid_effort',
      }, { status: 400 });
    }

    // An explicit repoPath is untrusted input: validate it against the registry before
    // anything else runs (traversal guard, asserted by the cold-start route contract).
    let cwd: string | null = null;
    if (repoPath?.trim()) {
      const { resolveRepoPathFromRegistry } = await import('@/lib/repos/repo-path-registry');
      const resolved = await resolveRepoPathFromRegistry(repoPath.trim());
      if (!resolved.ok) {
        return NextResponse.json({
          error: `[repo] ${resolved.message}`,
          code: 'repo_unavailable',
        }, { status: resolved.status });
      }
      cwd = resolved.repoRoot;
    }

    let cmd: string;
    let args: string[];
    let codexModel: string | undefined;
    let cliSpec: {
      runtimeId: string;
      binaryName: string;
      humanLabel: string;
      envOverride: string;
    };

    switch (runtime) {
      case 'claude-code': {
        // Removed June 2026 — Anthropic's pricing change billed every
        // `claude --print` against the user's Agent SDK credit pool. We don't
        // want operators to accidentally route chat through the metered pool.
        // Operators who want Claude reach it directly via Claude Code TUI or
        // Claude Desktop, which stays on the unlimited interactive pool.
        return NextResponse.json({
          error: 'claude-code CLI is disabled. Use the LLM proxy with your ANTHROPIC_API_KEY, or talk to Claude in Claude Code / Desktop directly.',
        }, { status: 410 });
      }
      case 'codex': {
        const cliModel = CODEX_MODEL_MAP[modelKey] ?? MODEL_IDS.codexCliDefault;
        codexModel = cliModel;
        cmd = 'codex';
        cliSpec = {
          runtimeId: 'codex',
          binaryName: cmd,
          humanLabel: 'Codex',
          envOverride: 'O8_CODEX_BIN',
        };
        args = ['exec', '--json', '-c', `model="${cliModel}"`, '--', prompt];
        break;
      }
      case 'gemini': {
        const cliModel = GEMINI_MODEL_MAP[modelKey] ?? 'gemini-2.5-flash';
        cmd = 'gemini';
        cliSpec = {
          runtimeId: 'gemini',
          binaryName: cmd,
          humanLabel: 'Gemini CLI',
          envOverride: 'O8_GEMINI_BIN',
        };
        args = ['--prompt', prompt, '--output-format', 'stream-json', '--model', cliModel];
        break;
      }
      case 'opencode': {
        // OpenCode 2's auto-selected default is location-scoped, so pass a free
        // explicit model to keep this proxy deterministic across projects.
        cmd = 'opencode2';
        cliSpec = {
          runtimeId: 'opencode',
          binaryName: cmd,
          humanLabel: 'OpenCode 2',
          envOverride: 'O8_OPENCODE_BIN',
        };
        args = ['run', '--format', 'json', '-m', 'opencode/deepseek-v4-flash-free', '--auto', prompt];
        break;
      }
      default:
        return NextResponse.json({ error: `Unsupported runtime: ${runtime}` }, { status: 400 });
    }

    const effortInput = {
      requestedEffort: body.effort,
      runtime,
      model: codexModel ?? modelKey,
      explicitModel: runtime === 'codex' ? modelKey : undefined,
    };
    const codexLaunch = runtime === 'codex'
      ? resolveCodexLaunchContext({ ...effortInput, runtime }) : undefined;
    const effortPin = codexLaunch?.effortPin ?? resolveEffortPin(effortInput);
    if (!effortPin.ok) {
      return NextResponse.json({ error: effortPin.message, code: effortPin.code }, { status: 400 });
    }
    if (runtime === 'codex' && effortPin.selectedEffort) {
      args.splice(args.indexOf('--'), 0, '-c', `model_reasoning_effort=${effortPin.selectedEffort}`);
    }

    // Every runtime above puts the user's prompt on argv. On Windows an
    // npm-installed CLI can only be spawned through cmd.exe, which re-parses
    // its command line — `%VAR%` expands even inside quotes and an embedded
    // quote ends the argument — so routing free text that way is a command
    // injection, not a compatibility fix. Refuse with a reason instead of
    // wrapping it, and let a real `.exe` install through untouched.
    const promptOnArgvIsUnsafe = (binary: string) => spawnsViaInterpreter(binary);

    try {
      cmd = (await resolveCli(cliSpec)).path;
    } catch (error) {
      if (!(error instanceof CliNotFoundError)) throw error;
      return NextResponse.json({
        error: formatMissingCliError({
          ...cliSpec,
          triedPaths: error.triedPaths,
        }),
        code: 'runtime_not_installed',
        runtime,
      }, { status: 503 });
    }

    if (promptOnArgvIsUnsafe(cmd)) {
      return NextResponse.json({
        error: `${cliSpec.humanLabel} is installed as a Windows shim (${cmd}), which o8 can only start through the command interpreter. `
          + 'Prompts would have to pass through that interpreter, so this route refuses rather than risk mangling or misreading them. '
          + 'Use the LLM proxy with an API key, or an install that provides a real .exe.',
        code: 'runtime_unsupported_on_platform',
        runtime,
      }, { status: 501 });
    }

    // No repoPath at all is the "Current project" selection, not a licence to run in
    // process.cwd(): CLI runtimes refuse to start outside a trusted git repo and exit
    // without a word. Resolved AFTER the CLI check so a cold-start machine still hears
    // "runtime is not installed" first.
    if (!cwd) {
      const { resolveCurrentProjectRepo } = await import('@/lib/repos/repo-path-registry');
      const resolved = await resolveCurrentProjectRepo();
      if (!resolved.ok) {
        return NextResponse.json({
          error: `[repo] ${resolved.message}`,
          code: 'repo_unavailable',
        }, { status: resolved.status });
      }
      cwd = resolved.repoRoot;
    }
    const repoRoot = cwd;
    const resolvedRefusal = knowledgeSourceWriteRefusal(repoRoot);
    if (resolvedRefusal) return resolvedRefusal;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let retried = false;
        let closed = false;
        const run = () => {
          const child = spawn(cmd, args, {
            windowsHide: true,
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: providerSpawnEnvironment(childEnvironment({ runtimeId: runtime, env: { FORCE_COLOR: '0', NO_COLOR: '1', ...codexLaunch?.env } }), { runtimeId: runtime }),
          });

          let buffer = '';
          let emitted = 0;
          let stderrTail = '';
          let unsupported = false;
          let sawActivity = false;

          const emit = (event: Record<string, unknown>) => {
            emitted += 1;
            controller.enqueue(encoder.encode(sse(event)));
          };

          // `message` and `text` carry the same string: consumers of this stream read one
          // or the other (mobile chat + durable send read `message`, the workspace chat
          // pane reads `text`), and an error nobody can render is the same as no error.
          const emitError = (reason: string) => {
            controller.enqueue(encoder.encode(sse({ type: 'error', message: reason, text: reason })));
          };

          child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf-8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                sawActivity ||= runtime === 'codex' && (parsed.type === 'item.started' || parsed.type === 'item.completed');
                if (runtime === 'codex' && (parsed.type === 'error' || parsed.type === 'turn.failed')) {
                  unsupported ||= isCodexSolUnsupported(codexModel, parsed.message ?? parsed.error?.message ?? parsed.error ?? '');
                }
                const events = normalizeCliEvent(runtime, parsed);
                for (const event of events) {
                  emit(event);
                }
              } catch {
                // Not JSON, skip
              }
            }
          });

          child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8').trim();
            if (text && !text.includes('DeprecationWarning')) {
              console.error(`[cli-proxy] ${runtime} stderr:`, text);
              stderrTail = `${stderrTail}${stderrTail ? '\n' : ''}${text}`.slice(-STDERR_TAIL_CHARS);
              unsupported ||= runtime === 'codex' && isCodexSolUnsupported(codexModel, text + stderrTail);
            }
          });

          child.on('close', (code) => {
            if (closed) return;
            // Flush remaining buffer
            if (buffer.trim()) {
              try {
                const parsed = JSON.parse(buffer);
                sawActivity ||= runtime === 'codex' && (parsed.type === 'item.started' || parsed.type === 'item.completed');
                if (runtime === 'codex' && (parsed.type === 'error' || parsed.type === 'turn.failed')) {
                  unsupported ||= isCodexSolUnsupported(codexModel, parsed.message ?? parsed.error?.message ?? parsed.error ?? '');
                }
                const events = normalizeCliEvent(runtime, parsed);
                for (const event of events) {
                  emit(event);
                }
              } catch { /* ignore */ }
            }
            if (runtime === 'codex' && !retried && !sawActivity && emitted === 0 && !request.signal.aborted && unsupported) {
              retried = true;
              codexModel = CODEX_SOL_FALLBACK_MODEL;
              controller.enqueue(encoder.encode(sse({ type: 'content', text: `${CODEX_SOL_UPDATE_NOTICE}\n\n` })));
              args = args.map((arg) => arg.startsWith('model=') ? `model="${CODEX_SOL_FALLBACK_MODEL}"` : arg);
              run();
              return;
            }
            // A silent exit used to close the stream with a bare `done`, which every
            // surface renders as "No response received." — say what actually happened.
            if (emitted === 0 || (typeof code === 'number' && code !== 0)) {
              emitError(describeSilentExit({
                label: cliSpec.humanLabel,
                code,
                cwd: repoRoot,
                stderrTail,
                producedOutput: emitted > 0,
              }));
            }
            controller.enqueue(encoder.encode(sse({ type: 'done' })));
            closed = true;
            controller.close();
          });

          child.on('error', (err) => {
            if (closed) return;
            emitError(err.message);
            closed = true;
            controller.close();
          });
        };
        run();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    console.error('[cli-proxy] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'CLI proxy failed' },
      { status: 500 },
    );
  }
}

// ── Normalize CLI events to our SSE format ──

type SseEvent = Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalizeCliEvent(runtime: CliRuntime, raw: any): SseEvent[] {
  switch (runtime) {
    case 'claude-code':
      return normalizeClaude(raw);
    case 'codex':
      return normalizeCodex(raw);
    case 'gemini':
      return normalizeGemini(raw);
    case 'opencode':
      return normalizeOpenCode(raw);
    default:
      return [];
  }
}

function normalizeClaude(raw: any): SseEvent[] {
  const events: SseEvent[] = [];

  if (raw.type === 'assistant' && raw.message?.content) {
    for (const block of raw.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        events.push({ type: 'thinking', text: block.thinking });
      }
      if (block.type === 'text' && block.text) {
        events.push({ type: 'content', text: block.text });
      }
      if (block.type === 'tool_use') {
        events.push({ type: 'tool_call', toolName: block.name, toolId: block.id, args: block.input ?? {} });
      }
    }
    if (raw.message.usage) {
      events.push({
        type: 'usage',
        inputTokens: raw.message.usage.input_tokens ?? 0,
        outputTokens: raw.message.usage.output_tokens ?? 0,
        cacheReadTokens: raw.message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: raw.message.usage.cache_creation_input_tokens ?? 0,
      });
    }
  }

  if (raw.type === 'result') {
    if (raw.usage) {
      events.push({
        type: 'usage',
        inputTokens: raw.usage.input_tokens ?? 0,
        outputTokens: raw.usage.output_tokens ?? 0,
        cacheReadTokens: raw.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: raw.usage.cache_creation_input_tokens ?? 0,
      });
    }
  }

  return events;
}

function normalizeCodex(raw: any): SseEvent[] {
  const events: SseEvent[] = [];

  if (raw.type === 'item.completed' && raw.item?.text) {
    events.push({ type: 'content', text: raw.item.text });
  }

  if (raw.type === 'turn.completed' && raw.usage) {
    events.push({
      type: 'usage',
      inputTokens: raw.usage.input_tokens ?? 0,
      outputTokens: raw.usage.output_tokens ?? 0,
    });
  }

  return events;
}

function normalizeGemini(raw: any): SseEvent[] {
  const events: SseEvent[] = [];

  if (raw.type === 'message' && raw.role === 'assistant' && raw.content) {
    events.push({ type: 'content', text: raw.content });
  }

  if (raw.type === 'result' && raw.stats) {
    events.push({
      type: 'usage',
      inputTokens: raw.stats.input_tokens ?? raw.stats.input ?? 0,
      outputTokens: raw.stats.output_tokens ?? 0,
    });
  }

  return events;
}

function normalizeOpenCode(raw: any): SseEvent[] {
  // opencode --format json emits envelope events of the shape:
  //   { type: 'step_start' | 'text' | 'tool' | 'step_finish', part: {...} }
  // where `part.type` describes the inner block. Verified against opencode 1.4.3.
  const events: SseEvent[] = [];
  const part = raw.part;

  if (raw.type === 'text' && part?.type === 'text' && typeof part.text === 'string') {
    events.push({ type: 'content', text: part.text });
  }

  // Tool invocation — opencode emits the tool call inside a part with type='tool'
  if (raw.type === 'tool' && part?.type === 'tool' && part.name) {
    events.push({
      type: 'tool_call',
      toolName: part.name,
      toolId: part.id ?? '',
      args: part.input ?? part.arguments ?? {},
    });
  }

  // Reasoning / thinking blocks
  if (raw.type === 'reasoning' && part?.type === 'reasoning' && typeof part.text === 'string') {
    events.push({ type: 'thinking', text: part.text });
  }

  // Usage on step finish — { tokens: { input, output, reasoning, cache, total }, cost }
  if (raw.type === 'step_finish' && part?.tokens) {
    events.push({
      type: 'usage',
      inputTokens: part.tokens.input ?? 0,
      outputTokens: part.tokens.output ?? 0,
      ...(typeof part.cost === 'number' ? { costUsd: part.cost } : {}),
    });
  }

  return events;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
