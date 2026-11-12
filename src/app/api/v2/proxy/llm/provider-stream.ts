import { createApproval } from '@/lib/approvals/store';
import { evaluatePolicy, buildPolicyContext } from '@/lib/approvals/policies';
import { consumeLlmToolGrant } from '@/lib/approvals/llm-tool-grants';
import type { AuthContext } from '@/lib/auth/middleware';
import { logUsage } from '@/lib/db/usage';
import { parseAnthropicStopMetadata, type AnthropicStopMetadata, type ResolvedAnthropicTaskBudget } from '@/lib/llm/anthropic-task-budget';
import { canonicalizeTerminalToolArgs, executeTool, terminalApprovalSummary, type ToolResult } from '@/lib/llm/tools';
import { ChatGPTPlanError } from '@/lib/chatgpt-plan/types';
import type { Message, ProviderConfig, Provider } from './provider-config';

export type AnthropicUsageTotals = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
type UsageOptions = { stopMetadata?: AnthropicStopMetadata | null; taskBudget?: ResolvedAnthropicTaskBudget | null };
interface StreamOptions {
  provider: Exclude<Provider, 'google' | 'operator'>; model: string; config: ProviderConfig; auth: AuthContext | null;
  upstream: Response; messages: Message[]; rawMessages: Message[]; effectiveRepoRoot: string;
  tabId: string; approvalGrant: string | null; anthropicTaskBudget: ResolvedAnthropicTaskBudget | null;
  fetchUpstream: (messages: Message[]) => Promise<Response>;
  buildUsageEvent: (provider: string, model: string, usage: AnthropicUsageTotals, options?: UsageOptions) => Record<string, unknown>;
  parseAnthropicStreamUsage: (line: string) => { cacheReadTokens: number; cacheWriteTokens: number } | null;
  mergeAnthropicStopState: (current: AnthropicStopMetadata | null, next: AnthropicStopMetadata | null) => AnthropicStopMetadata | null;
  signal: AbortSignal;
  planOwner?: string | null;
  planSelection?: { accountId: string; generation: number; desktopEpoch: string };
  toolAdmission?: <T>(action: () => Promise<T>) => Promise<T>;
  allowedTools?: readonly string[];
}

function approvalTitleForTool(toolName: string) {
  if (toolName === 'run_terminal_command') return 'Run terminal command';
  if (toolName === 'write_file') return 'Write file';
  if (toolName === 'edit_file') return 'Edit file';
  if (toolName === 'delete_file') return 'Delete file';
  if (toolName === 'create_github_issue') return 'Create GitHub issue';
  if (toolName === 'create_pull_request') return 'Create pull request';
  if (toolName === 'lane_command') return 'Lane command';
  return `Execute ${toolName}`;
}

/** Shared policy and approval loop, used by API-key and ChatGPT-plan calls. */
export function createProviderToolStream(options: StreamOptions): Response {
  const { provider, model, config, auth, upstream, messages, rawMessages, effectiveRepoRoot, tabId, approvalGrant, anthropicTaskBudget, fetchUpstream, buildUsageEvent, parseAnthropicStreamUsage, mergeAnthropicStopState, signal } = options;
  let totalUsage: AnthropicUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let latestAnthropicStopMetadata: AnthropicStopMetadata | null = null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      async function processStream(response: globalThis.Response): Promise<{
        toolCalls: Array<{ name: string; id: string; args: Record<string, unknown> }>;
        usage: AnthropicUsageTotals;
        stopMetadata: AnthropicStopMetadata | null;
      }> {
        const reader = response.body?.getReader();
        if (!reader) {
          return {
            toolCalls: [],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            stopMetadata: null,
          };
        }

        const decoder = new TextDecoder();
        let buffer = '';
        const toolCalls: Array<{ name: string; id: string; args: Record<string, unknown> }> = [];
        let currentToolName = '';
        let currentToolId = '';
        let currentToolArgs = '';
        const usage: AnthropicUsageTotals = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        let stopMetadata: AnthropicStopMetadata | null = null;
        let completed = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (signal.aborted) throw new ChatGPTPlanError('request_cancelled', 'The request was stopped.');

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (provider === 'anthropic') {
                const anthropicUsage = parseAnthropicStreamUsage(line);
                if (anthropicUsage) {
                  usage.cacheReadTokens = Math.max(usage.cacheReadTokens, anthropicUsage.cacheReadTokens);
                  usage.cacheWriteTokens = Math.max(usage.cacheWriteTokens, anthropicUsage.cacheWriteTokens);
                }
                stopMetadata = mergeAnthropicStopState(stopMetadata, parseAnthropicStopMetadata(line));
              }
              const parsed = config.parseStream(line);
              if (!parsed) continue;

              if (parsed.type === 'thinking') {
                enqueue(JSON.stringify({ type: 'thinking', text: parsed.text }));
                continue;
              }
              if (parsed.type === 'content') {
                enqueue(JSON.stringify({ type: 'content', text: parsed.text }));
                continue;
              }
              if (parsed.type === 'completed') {
                completed = true; usage.inputTokens += parsed.inputTokens; usage.outputTokens += parsed.outputTokens; continue;
              }
              if (parsed.type === 'usage') {
                usage.inputTokens += parsed.inputTokens;
                usage.outputTokens += parsed.outputTokens;
                continue;
              }
              if (parsed.type === 'tool_call_start') {
                currentToolName = parsed.toolName;
                currentToolId = parsed.toolId;
                currentToolArgs = '';
                enqueue(JSON.stringify({ type: 'tool_call', name: parsed.toolName, status: 'calling' }));
                continue;
              }
              if (parsed.type === 'tool_call_delta') {
                currentToolArgs += parsed.json;
                continue;
              }
              if (parsed.type === 'tool_call_end') {
                try {
                  const args = currentToolArgs ? JSON.parse(currentToolArgs) as Record<string, unknown> : {};
                  toolCalls.push({ name: currentToolName, id: currentToolId, args });
                } catch {
                  toolCalls.push({ name: currentToolName, id: currentToolId, args: {} });
                }
                continue;
              }
              if (parsed.type === 'tool_call') {
                toolCalls.push({ name: parsed.toolName, id: parsed.toolId, args: parsed.args });
                enqueue(JSON.stringify({ type: 'tool_call', name: parsed.toolName, status: 'calling' }));
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }

        if (provider === 'chatgpt' && !completed) throw new ChatGPTPlanError('stream_incomplete', 'The ChatGPT response ended before completion. No other billing route was used.', 502);
        return { toolCalls, usage, stopMetadata };
      }

      try {
        const initialResult = await processStream(upstream);
        let toolCalls = initialResult.toolCalls;
        const { usage, stopMetadata } = initialResult;
        totalUsage = {
          inputTokens: totalUsage.inputTokens + usage.inputTokens,
          outputTokens: totalUsage.outputTokens + usage.outputTokens,
          cacheReadTokens: totalUsage.cacheReadTokens + usage.cacheReadTokens,
          cacheWriteTokens: totalUsage.cacheWriteTokens + usage.cacheWriteTokens,
        };
        latestAnthropicStopMetadata = mergeAnthropicStopState(latestAnthropicStopMetadata, stopMetadata);
        if (stopMetadata?.stopReason === 'budget_exhausted') {
          console.info(`[llm-proxy] Anthropic stop_reason=budget_exhausted`);
        }
        let loopCount = 0;
        const allSources: Array<{ title: string; url?: string; path?: string }> = [];

        while (toolCalls.length > 0 && loopCount < 8) {
          loopCount += 1;
          const toolResultParts: string[] = [];

          for (const toolCall of toolCalls) {
            if (signal.aborted) throw new ChatGPTPlanError('request_cancelled', 'The request was stopped.');
            if (options.allowedTools && !options.allowedTools.includes(toolCall.name)) throw new ChatGPTPlanError('tool_not_available', 'ChatGPT requested a tool unavailable in this turn.', 403);
            const policyContext = buildPolicyContext(toolCall.name, toolCall.args, {
              runtime: 'chat',
              workspacePath: effectiveRepoRoot,
              sessionKey: tabId ? `llm-chat:${tabId}` : undefined,
            });
            const exactCallApproved = consumeLlmToolGrant({
              token: approvalGrant,
              tabId,
              repoPath: effectiveRepoRoot,
              toolName: toolCall.name,
              args: toolCall.args,
            });
            const policyResult = exactCallApproved
              ? { requiresApproval: false, risk: 'low' as const, reason: 'Exact one-shot approval', ruleId: 'one-shot-approval', blocked: false }
              : evaluatePolicy(policyContext);

            if (policyResult.blocked) {
              const command = (toolCall.args.command as string) || toolCall.name;
              enqueue(JSON.stringify({
                type: 'tool_result',
                name: toolCall.name,
                status: 'blocked',
                preview: `Blocked: ${policyResult.reason}`,
              }));
              messages.push(
                { role: 'assistant', content: `I'll run: ${command}` },
                { role: 'user', content: `Tool "${toolCall.name}" was blocked by policy "${policyResult.ruleId}": ${policyResult.reason}. Suggest a safe alternative.` },
              );
              continue;
            }

            if (policyResult.requiresApproval) {
              const approvalArgs = toolCall.name === 'run_terminal_command' ? canonicalizeTerminalToolArgs(effectiveRepoRoot, toolCall.args) : toolCall.args;
              const command = toolCall.name === 'run_terminal_command' ? (toolCall.args.command as string) : '';
              let summary = `Execute ${toolCall.name}`;
              let diff: { before?: string; after?: string; path?: string } | undefined;

              if (toolCall.name === 'create_github_issue') {
                summary = `Create issue: "${toolCall.args.title}" in ${toolCall.args.repo}`;
              } else if (toolCall.name === 'create_pull_request') {
                summary = `Create PR: "${toolCall.args.title}" on branch ${toolCall.args.branch}`;
              } else if (toolCall.name === 'run_terminal_command') {
                summary = terminalApprovalSummary(effectiveRepoRoot, approvalArgs);
              } else if (toolCall.name === 'write_file') {
                const filePath = String(toolCall.args.path || '');
                const content = String(toolCall.args.content || '');
                summary = `Write to ${filePath} (${content.split('\n').length} lines)`;
                diff = { before: '', after: content, path: filePath };
              } else if (toolCall.name === 'edit_file') {
                const filePath = String(toolCall.args.path || '');
                summary = `Edit ${filePath}`;
                diff = {
                  before: String(toolCall.args.oldText || ''),
                  after: String(toolCall.args.newText || ''),
                  path: filePath,
                };
              } else if (toolCall.name === 'delete_file') {
                summary = `Delete file: ${toolCall.args.path}`;
              }

              const approval = tabId
                ? createApproval({
                    source: 'llm-chat',
                    runtime: 'chat',
                    agent: 'Chat',
                    sessionKey: `llm-chat:${tabId}`,
                    title: approvalTitleForTool(toolCall.name),
                    description: summary,
                    summary,
                    toolName: toolCall.name,
                    args: approvalArgs,
                    command: command || undefined,
                    editable: toolCall.name === 'run_terminal_command',
                    diff,
                    risk: policyResult.risk,
                    policyRuleId: policyResult.ruleId,
                    metadata: {
                      Model: model,
                      Tool: toolCall.name,
                      ...(command ? { Command: command } : {}),
                      ...(!command && toolCall.args.path ? { Path: String(toolCall.args.path) } : {}),
                    },
                    continuation: {
                      kind: 'llm-chat',
                      tabId,
                      model,
                      provider,
                      messages: rawMessages,
                      approvedTools: [],
                      repoPath: effectiveRepoRoot,
                      ...(options.planOwner && options.planSelection ? { planOwner: options.planOwner, planAccountId: options.planSelection.accountId, planGeneration: options.planSelection.generation, planDesktopEpoch: options.planSelection.desktopEpoch } : {}),
                    },
                  })
                : null;

              enqueue(JSON.stringify({
                type: 'approval_required',
                id: approval?.id,
                name: toolCall.name,
                args: approvalArgs,
                editable: toolCall.name === 'run_terminal_command',
                summary,
                diff,
              }));
              enqueue(JSON.stringify({ type: 'content', text: '' }));
              enqueue(JSON.stringify(buildUsageEvent(provider, model, totalUsage, {
                stopMetadata: latestAnthropicStopMetadata,
                taskBudget: anthropicTaskBudget,
              })));
              enqueue('[DONE]');
              controller.close();
              return;
            }

            enqueue(JSON.stringify({
              type: 'tool_call',
              name: toolCall.name,
              status: 'running',
              args: toolCall.args,
            }));

            const runTool = () => executeTool(toolCall.name, toolCall.args, effectiveRepoRoot);
            const result: ToolResult = options.toolAdmission ? await options.toolAdmission(runTool) : await runTool();
            if (result.sources) {
              allSources.push(...result.sources);
            }

            enqueue(JSON.stringify({
              type: 'tool_result',
              name: toolCall.name,
              status: 'done',
              preview: result.content.slice(0, 200),
            }));
            toolResultParts.push(`[${toolCall.name}] ${result.content}`);
          }

          const toolNames = toolCalls.map((toolCall) => toolCall.name).join(', ');
          messages.push(
            { role: 'assistant', content: `I used the following tools: ${toolNames}` },
            {
              role: 'user',
              content: `Tool results:\n\n${toolResultParts.join('\n\n---\n\n')}\n\nBased on these results, provide your complete response to the user. Do not call more tools unless absolutely necessary.`,
            },
          );

          let followResponse: globalThis.Response;
          try {
            followResponse = await fetchUpstream(messages);
          } catch (error) {
            if (provider === 'chatgpt') throw error;
            break;
          }
          if (!followResponse.ok) {
            if (provider === 'chatgpt') throw new ChatGPTPlanError('plan_request_failed', 'The ChatGPT plan continuation stopped.', followResponse.status);
            break;
          }
          const followResult = await processStream(followResponse);
          toolCalls = followResult.toolCalls;
          totalUsage = {
            inputTokens: totalUsage.inputTokens + followResult.usage.inputTokens,
            outputTokens: totalUsage.outputTokens + followResult.usage.outputTokens,
            cacheReadTokens: totalUsage.cacheReadTokens + followResult.usage.cacheReadTokens,
            cacheWriteTokens: totalUsage.cacheWriteTokens + followResult.usage.cacheWriteTokens,
          };
          latestAnthropicStopMetadata = mergeAnthropicStopState(
            latestAnthropicStopMetadata,
            followResult.stopMetadata,
          );
          if (followResult.stopMetadata?.stopReason === 'budget_exhausted') {
            console.info(`[llm-proxy] Anthropic stop_reason=budget_exhausted`);
          }
        }

        if (provider === 'chatgpt' && toolCalls.length > 0) {
          throw new ChatGPTPlanError('tool_turn_limit', 'The ChatGPT tool turn limit was reached. The turn is held for review.');
        }

        const seen = new Set<string>();
        const sources = allSources.filter((source) => {
          const key = `${source.title}|${source.url ?? ''}|${source.path ?? ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (sources.length > 0) {
          enqueue(JSON.stringify({
            type: 'sources',
            sources: sources.map((source, index) => ({ ...source, index: index + 1 })),
          }));
        }

        const usageEvent = buildUsageEvent(provider, model, totalUsage, {
          stopMetadata: latestAnthropicStopMetadata,
          taskBudget: anthropicTaskBudget,
        });
        enqueue(JSON.stringify(usageEvent));
        enqueue('[DONE]');

        if (provider !== 'chatgpt' && auth?.user && totalUsage.outputTokens > 0) {
          try {
            const costUsd = typeof usageEvent.costUsd === 'number' ? usageEvent.costUsd : 0;
            logUsage({
              userId: auth.user.id,
              model,
              provider,
              inputTokens: totalUsage.inputTokens,
              outputTokens: totalUsage.outputTokens,
              cacheReadTokens: totalUsage.cacheReadTokens,
              cacheWriteTokens: totalUsage.cacheWriteTokens,
              costUsd,
              agentName: 'llm-chat',
              requestType: 'chat',
            });
          } catch {
            console.error('[proxy/llm] Failed to log usage');
          }
        }
      } catch (error) {
        enqueue(JSON.stringify({
          type: 'error',
          message: error instanceof ChatGPTPlanError ? error.message : 'Stream error',
          ...(error instanceof ChatGPTPlanError ? { code: error.code } : {}),
        }));
      } finally {
        try {
          controller.close();
        } catch {
          return;
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
