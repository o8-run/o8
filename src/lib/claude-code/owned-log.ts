import { observedCacheTokens, reportedRunModel } from '@/lib/prompt-cache/usage-evidence';
/** Pure Claude log parsing; importing this module creates no runtime store. */
import { createClaudeCodeStreamJsonParser, type ClaudeCodeStreamJsonParserEvent } from './stream-json-parser';
import type { OwnedRunRecord, OwnedTailEntry, ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';

function eventText(event: ClaudeCodeStreamJsonParserEvent): string {
  switch (event.type) {
    case 'delta':
    case 'thinking':
    case 'plan_step':
      return event.text;
    case 'tool_call':
      return event.preview ?? event.name;
    case 'tool_result':
      return event.preview ?? event.output ?? event.name ?? 'Tool result';
    case 'permission_request':
      return event.text;
    case 'usage':
      return `Usage: ${event.inputTokens} input, ${event.outputTokens} output${event.cacheReadTokens ? `, ${event.cacheReadTokens} cache read` : ''}${event.cacheWriteTokens ? `, ${event.cacheWriteTokens} cache write` : ''}`;
    case 'done':
      return event.text;
  }
}

function entryKind(event: ClaudeCodeStreamJsonParserEvent): OwnedTailEntry['kind'] {
  if (event.type === 'tool_call') return 'tool';
  if (event.type === 'tool_result') return 'tool-output';
  if (event.type === 'delta' || event.type === 'thinking' || event.type === 'done') return 'message';
  return 'event';
}

export function parseClaudeOwnedRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog {
  const parser = createClaudeCodeStreamJsonParser();
  const events = [...parser.pushChunk(raw), ...parser.flush()];
  const entries: OwnedTailEntry[] = [];
  const assistantBlocks = new Map<string, OwnedTailEntry>();
  const thinkingBlocks = new Map<string, OwnedTailEntry>();
  let eventOrdinal = 0;
  let hasAssistantText = false;

  for (const event of events) {
    if (event.type === 'delta') {
      const blockKey = `${event.messageKey ?? event.messageIndex ?? 0}:${event.blockIndex ?? 0}`;
      let entry = assistantBlocks.get(blockKey);
      if (!entry) {
        entry = {
          id: `${run.id}:message:${blockKey}`,
          kind: 'message',
          label: 'claude-assistant',
          text: '',
          timestamp: run.startedAt,
        };
        assistantBlocks.set(blockKey, entry);
        entries.push(entry);
      }
      // Deltas split Markdown tokens arbitrarily. Preserve every byte so the
      // renderer receives one complete answer rather than fragment rows.
      entry.text += event.text;
      hasAssistantText = hasAssistantText || event.text.length > 0;
      continue;
    }

    if (event.type === 'thinking') {
      const blockKey = `${event.messageKey ?? event.messageIndex ?? 0}:${event.blockIndex ?? 0}`;
      let entry = thinkingBlocks.get(blockKey);
      if (!entry) {
        entry = {
          id: `${run.id}:thinking:${blockKey}`,
          kind: 'message',
          label: 'thinking',
          text: '',
          timestamp: run.startedAt,
          thinking: '',
          thinkingActive: true,
        };
        thinkingBlocks.set(blockKey, entry);
        entries.push(entry);
      }
      entry.thinking = `${entry.thinking ?? ''}${event.text}`;
      if (event.text) entry.thinkingActive = false;
      continue;
    }

    if (event.type === 'done') {
      // The result is a terminal summary. When stream deltas already built the
      // answer it is a replay, not another visible assistant message.
      if (event.isError) {
        const errorText = event.text || 'Worker reported an error.';
        if (!entries.some((entry) => entry.text === errorText)) {
          entries.push({
            id: `${run.id}:terminal-error`, kind: 'event', label: 'error',
            text: errorText, timestamp: run.startedAt,
          });
        }
      } else if (!hasAssistantText && event.text) {
        entries.push({
          id: `${run.id}:message:result`,
          kind: 'message',
          label: 'claude-assistant',
          text: event.text,
          timestamp: run.startedAt,
        });
      }
      continue;
    }

    if (event.type === 'tool_call') {
      const text = eventText(event);
      entries.push({
        id: `${run.id}:tool:${event.id ?? eventOrdinal}`,
        kind: 'tool',
        label: event.name,
        text,
        timestamp: run.startedAt,
        toolCall: {
          ...(event.id ? { id: event.id } : {}),
          name: event.name,
          ...(event.args ? { args: event.args } : {}),
          ...(event.preview ? { preview: event.preview } : {}),
          status: 'running',
        },
      });
      eventOrdinal += 1;
      continue;
    }

    if (event.type === 'tool_result') {
      const text = eventText(event);
      entries.push({
        id: `${run.id}:tool-result:${event.id ?? eventOrdinal}`,
        kind: 'tool-output',
        label: event.name ?? 'tool',
        text,
        timestamp: run.startedAt,
        toolCall: {
          ...(event.id ? { id: event.id } : {}),
          name: event.name ?? 'tool',
          ...(event.args ? { args: event.args } : {}),
          ...(event.preview ? { preview: event.preview } : {}),
          status: event.isError ? 'error' : 'done',
          ...(event.output ? { result: event.output } : {}),
        },
      });
      eventOrdinal += 1;
      continue;
    }

    const text = eventText(event);
    if (!text) continue;
    entries.push({
      id: `${run.id}:${event.type}:${eventOrdinal}`,
      kind: entryKind(event),
      label: event.type,
      text,
      timestamp: run.startedAt,
    });
    eventOrdinal += 1;
  }
  const done = events.find((event): event is Extract<ClaudeCodeStreamJsonParserEvent, { type: 'done' }> =>
    event.type === 'done');
  const usage = [...events].reverse().find(
    (event): event is Extract<ClaudeCodeStreamJsonParserEvent, { type: 'usage' }> => event.type === 'usage',
  );
  const assistant = [...entries].reverse().find(entry => entry.kind === 'message');
  const terminalUsage = done?.inputTokens !== undefined ? done : usage;
  if (assistant && terminalUsage) {
    assistant.model = reportedRunModel(raw);
    assistant.tokens = observedCacheTokens({ ...terminalUsage });
    assistant.timestamp = run.finishedAt ?? run.startedAt;
  }
  const inputTokens = done?.inputTokens ?? usage?.inputTokens ?? 0;
  const cacheReadTokens = done?.cacheReadTokens ?? usage?.cacheReadTokens ?? 0;
  const contextTokens = inputTokens + cacheReadTokens;
  const terminalMissing = !done && Boolean(run.childExit || run.finishedAt)
    && run.outcome !== 'interrupted' && !run.interruptRequestedAt;
  const providerFailed = done?.isError === true || terminalMissing;

  return {
    threadId: done?.sessionId ?? parser.getState().sessionId ?? undefined,
    entries,
    outcome: providerFailed ? 'failed' : done ? 'finished' : 'running',
    completedTurn: Boolean(done && !providerFailed),
    ...(providerFailed ? {
      providerFailure: terminalMissing ? {
        subtype: 'missing_result',
        message: 'Worker exited without a terminal result.',
      } : {
        ...(done?.subtype ? { subtype: done.subtype } : {}),
        ...(done?.text.trim() ? { message: done.text.trim() } : {}),
      },
    } : {}),
    ...(contextTokens > 0 ? {
      turnContextUsage: { inputTokens, cacheReadTokens, contextTokens },
    } : {}),
  };
}
