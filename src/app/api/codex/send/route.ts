import { childEnvironment } from '@/lib/providers/spawn-environment';
import { NextRequest } from 'next/server';
import { spawn } from '@/lib/providers/child-process';
import os from 'os';

import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { formatMissingCliError } from '@/lib/runtimes/shared/cli-unavailable';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
import { assertNotKnowledgeSource } from '@/lib/cortex/knowledge/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SendRequest {
  message: string;
  cwd?: string;
  threadId?: string; // Codex thread UUID for resume
  model?: string;
}

function parseCodexArgs(raw: unknown) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { input: parsed };
  } catch {
    return { input: trimmed };
  }
}

function extractCodexMessageText(item: Record<string, unknown>) {
  if (typeof item.text === 'string' && item.text.trim()) return item.text;
  const content = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [];
  return content
    .filter((part) => part.type === 'output_text' || part.type === 'input_text')
    .map((part) => String(part.text ?? ''))
    .join(' ')
    .trim();
}

function extractCodexReasoningText(item: Record<string, unknown>) {
  const summary = Array.isArray(item.summary) ? item.summary as Array<Record<string, unknown>> : [];
  return summary
    .map((part) => {
      if (typeof part.text === 'string') return part.text;
      if (typeof part.summary_text === 'string') return part.summary_text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function shouldSuppressCodexStderrLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.includes('failed to stat skills entry') && trimmed.includes('/.codex/skills/')) return true;
  if (trimmed.includes('rmcp::transport::worker') && trimmed.includes('Connection refused')) return true;
  return false;
}

/**
 * POST /api/codex/send
 *
 * Sends a message to Codex CLI in exec mode and streams the response.
 * Uses --json for JSONL event streaming.
 *
 * If threadId is provided, resumes that conversation via `codex exec resume`.
 * Otherwise starts a new exec session in the given cwd.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as SendRequest | null;
  if (!body) {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }
  const { message, cwd, threadId, model } = body;

  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: 'Message is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Expand tilde in workspace paths
  const expandedCwd = cwd?.replace(/^~/, os.homedir());
  const workingDir = expandedCwd || process.cwd();
  try {
    assertNotKnowledgeSource(workingDir);
    if (expandedCwd) assertOrchestratorRepoPath(expandedCwd);
  } catch (error) {
    return Response.json({
      error: `[repo] ${error instanceof Error ? error.message : 'The workspace is unavailable.'}`,
      code: 'repo_unavailable',
    }, { status: 400 });
  }

  const cliSpec = {
    runtimeId: 'codex',
    binaryName: 'codex',
    humanLabel: 'Codex',
    envOverride: 'O8_CODEX_BIN',
  };
  let codexBin: string;
  try {
    codexBin = (await resolveCli(cliSpec)).path;
  } catch (error) {
    if (!(error instanceof CliNotFoundError)) {
      console.error('[codex-send] Failed to resolve Codex:', error);
      return Response.json({
        error: '[runtime] Codex could not be started. Check the server log for details.',
        code: 'runtime_resolution_failed',
      }, { status: 500 });
    }
    return Response.json({
      error: formatMissingCliError({
        ...cliSpec,
        triedPaths: error.triedPaths,
      }),
      code: 'runtime_not_installed',
    }, { status: 503 });
  }

  // Build command args
  let args: string[];
  if (threadId) {
    // Resume existing conversation
    args = ['exec', 'resume', threadId, message, '--json', '--dangerously-bypass-approvals-and-sandbox'];
  } else {
    // New conversation
    args = ['exec', message, '--json', '--dangerously-bypass-approvals-and-sandbox'];
  }

  if (model) {
    args.push('--model', model);
  }

  // CLI resolution can await; a newly configured source must still refuse the spawn.
  try {
    assertNotKnowledgeSource(workingDir);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'The workspace is unavailable.', code: 'repo_unavailable' }, { status: 400 });
  }
  const encoder = new TextEncoder();

  let markClientGone: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const launch = cliInvocation(codexBin, args);
      const child = spawn(launch.command, launch.args, {
        windowsHide: true,
        cwd: workingDir,
        env: providerSpawnEnvironment(childEnvironment({ runtimeId: 'codex', env: { FORCE_COLOR: '0', NO_COLOR: '1' } }), { runtimeId: 'codex' }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let fullResponse = '';
      let capturedThreadId = '';
      let streamClosed = false;
      markClientGone = () => {
        streamClosed = true;
      };
      const enqueueChunk = (chunk: Uint8Array) => {
        if (streamClosed) return;
        controller.enqueue(chunk);
      };
      const closeStream = () => {
        if (streamClosed) return;
        streamClosed = true;
        controller.close();
      };

	      child.stdout.on('data', (chunk: Buffer) => {
	        const text = chunk.toString();

	        for (const line of text.split('\n').filter(Boolean)) {
	          try {
	            const event = JSON.parse(line) as Record<string, unknown>;
	            const rawItem = (event.item ?? event.payload ?? {}) as Record<string, unknown>;

	            // Capture thread ID
	            if (event.type === 'thread.started' && event.thread_id) {
	              capturedThreadId = event.thread_id as string;
              enqueueChunk(encoder.encode(
                `data: ${JSON.stringify({ type: 'session', threadId: capturedThreadId })}\n\n`
              ));
            }

            // Agent message completed — the actual response text
	            if (event.type === 'item.completed' || event.type === 'response_item') {
	              const itemType = String(rawItem.type ?? '');
	              const itemRole = String(rawItem.role ?? '');
	              const messageText = extractCodexMessageText(rawItem);
	              const reasoningText = extractCodexReasoningText(rawItem);

	              if ((itemType === 'agent_message' || (itemType === 'message' && itemRole === 'assistant')) && messageText) {
	                fullResponse += messageText;
	                enqueueChunk(encoder.encode(
	                  `data: ${JSON.stringify({ type: 'delta', text: messageText })}\n\n`
	                ));
	              }

	              if (itemType === 'reasoning' && reasoningText) {
	                enqueueChunk(encoder.encode(
	                  `data: ${JSON.stringify({ type: 'thinking', text: reasoningText })}\n\n`
	                ));
	              }

	              if (itemType === 'tool_call' || itemType === 'function_call' || itemType === 'custom_tool_call') {
	                const toolName = typeof rawItem.name === 'string' ? rawItem.name : '';
	                if (toolName) {
	                  enqueueChunk(encoder.encode(
	                    `data: ${JSON.stringify({
	                      type: 'tool_call',
	                      name: toolName,
	                      status: 'running',
	                      args: parseCodexArgs(rawItem.arguments)
	                        ?? (typeof rawItem.input === 'string'
	                          ? parseCodexArgs(rawItem.input)
	                          : (rawItem.input && typeof rawItem.input === 'object' ? rawItem.input as Record<string, unknown> : undefined)),
	                    })}\n\n`
	                  ));
	                }
	              }

	              if ((itemType === 'function_call_output' || itemType === 'custom_tool_call_output') && typeof rawItem.output === 'string') {
	                enqueueChunk(encoder.encode(
	                  `data: ${JSON.stringify({
	                    type: 'tool_result',
	                    name: typeof rawItem.name === 'string' ? rawItem.name : undefined,
	                    preview: rawItem.output,
	                  })}\n\n`
	                ));
	              }
	            }

	            // Turn completed — usage info
	            if (event.type === 'turn.completed') {
	              const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
	              enqueueChunk(encoder.encode(
	                `data: ${JSON.stringify({
	                  type: 'usage',
	                  inputTokens: usage?.input_tokens,
	                  outputTokens: usage?.output_tokens,
	                })}\n\n`
	              ));
	              enqueueChunk(encoder.encode(
	                `data: ${JSON.stringify({
	                  type: 'done',
                text: fullResponse,
                threadId: capturedThreadId || undefined,
                inputTokens: usage?.input_tokens,
                outputTokens: usage?.output_tokens,
                })}\n\n`
              ));
            }
          } catch {
            // Not JSON or partial — skip
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const errLines = chunk.toString().split('\n').map((line) => line.trim()).filter(Boolean);
        const visibleLines = errLines.filter((line) => !shouldSuppressCodexStderrLine(line));
        if (visibleLines.length > 0) {
          enqueueChunk(encoder.encode(
            `data: ${JSON.stringify({ type: 'error', text: visibleLines.join('\n') })}\n\n`
          ));
        }
      });

      child.on('close', (code) => {
        enqueueChunk(encoder.encode(
          `data: ${JSON.stringify({
            type: 'close',
            exitCode: code,
            text: fullResponse,
            threadId: capturedThreadId || undefined,
          })}\n\n`
        ));
        closeStream();
      });

      child.on('error', (err) => {
        enqueueChunk(encoder.encode(
          `data: ${JSON.stringify({ type: 'error', delivery: 'rejected', text: err.message })}\n\n`
        ));
        closeStream();
      });

      child.stdin.end();
    },
    cancel() {
      // The CLI process keeps its own transcript/session state. Client-side
      // cancellation only releases the webview HTTP socket.
      markClientGone?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
