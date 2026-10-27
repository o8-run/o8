import { observedCacheTokens, reportedRunModel } from '@/lib/prompt-cache/usage-evidence';
/** Pure Codex log parsing; importing this module creates no runtime store. */
import { truncateText } from '@/lib/util/text';
import { compactText } from '@/lib/runtimes/shared/owned-session/helpers';
import type { OwnedRunRecord, OwnedTailEntry, ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return safeObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return safeObject(value);
}
function readStringField(source: Record<string, unknown> | null, ...keys: string[]) {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNestedStringField(source: Record<string, unknown> | null, keyPath: string[]) {
  let current: unknown = source;
  for (const key of keyPath) {
    const next = safeObject(current)?.[key];
    if (next == null) return undefined;
    current = next;
  }
  return typeof current === 'string' && current.trim() ? current.trim() : undefined;
}

function extractStructuredText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const record = safeObject(item);
        if (!record) return '';
        const nestedText = readStringField(record, 'text', 'message', 'summary_text');
        return nestedText ?? '';
      })
      .filter(Boolean)
      .join(' ');
  }

  const record = safeObject(value);
  if (!record) return '';

  const direct = readStringField(record, 'text', 'message', 'summary_text', 'output');
  if (direct) return direct;

  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const entry = safeObject(item);
        if (!entry) return '';
        if (entry.type === 'input_text' || entry.type === 'output_text') {
          return typeof entry.text === 'string' ? entry.text : '';
        }
        return readStringField(entry, 'text') ?? '';
      })
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function formatClock(timestampIso?: string) {
  if (!timestampIso) return undefined;
  const date = new Date(timestampIso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function parseEntryTimestamp(value: unknown, fallbackIso: string) {
  const timestamp = typeof value === 'string' && value.trim() ? value : fallbackIso;
  return {
    timestamp,
    timestampLabel: formatClock(timestamp) ?? formatClock(fallbackIso),
  };
}

function humanizeToolName(value?: string) {
  const raw = (value ?? '').trim();
  if (!raw) return 'tool';
  return raw.replace(/[_-]+/g, ' ').trim();
}

function collectToolPaths(payload: Record<string, unknown> | null): string[] {
  const candidates = [
    readStringField(payload, 'path', 'filePath', 'file_path', 'target_file', 'filename', 'fileName'),
    readNestedStringField(payload, ['input', 'path']),
    readNestedStringField(payload, ['input', 'file_path']),
    readNestedStringField(payload, ['input', 'filePath']),
    readNestedStringField(payload, ['arguments', 'path']),
    readNestedStringField(payload, ['arguments', 'file_path']),
    readNestedStringField(payload, ['arguments', 'filePath']),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
}

function describeToolActivity(toolName: string, rawInput: unknown): string {
  const input = parseJsonObject(rawInput);
  const normalizedName = toolName.trim();
  const command = readStringField(input, 'cmd', 'command', 'parsed_cmd', 'interaction_input')
    ?? readNestedStringField(input, ['command', 'cmd'])
    ?? readNestedStringField(input, ['input', 'cmd'])
    ?? readNestedStringField(input, ['input', 'command'])
    ?? readNestedStringField(input, ['arguments', 'cmd'])
    ?? readNestedStringField(input, ['arguments', 'command']);

  if (command && (
    normalizedName === 'exec_command'
    || normalizedName === 'shell_command'
    || normalizedName === 'run_user_shell_command'
    || normalizedName === 'command_execution'
  )) {
    return `Run ${compactText(command, 180)}`;
  }

  const paths = collectToolPaths(input);
  if (paths.length > 0) {
    const pathList = compactText(paths.join(', '), 180);
    if (normalizedName === 'apply_patch') return `Edit ${pathList}`;
    if (normalizedName === 'view_image') return `Inspect ${pathList}`;
    if (normalizedName === 'list_files') return `List files near ${pathList}`;
    if (normalizedName === 'read_file') return `Read ${pathList}`;
    if (normalizedName === 'write_file') return `Write ${pathList}`;
    if (normalizedName === 'grep' || normalizedName === 'search') return `Search ${pathList}`;
  }

  if (normalizedName === 'update_plan') return 'Update plan';
  if (normalizedName === 'apply_patch') return 'Apply patch';
  if (normalizedName === 'list_files') return 'List files';
  if (normalizedName === 'read_file') return 'Read file';
  if (normalizedName === 'write_file') return 'Write file';
  if (normalizedName === 'view_image') return 'Inspect image';

  return `Use ${humanizeToolName(normalizedName)}`;
}

function toolOutputPreview(value: unknown) {
  const text = extractStructuredText(value);
  return compactText(text, 500);
}

export function codexParseRunLog(
  raw: string,
  run: OwnedRunRecord,
  fallbackTimestamp = run.finishedAt ?? run.startedAt,
): ParsedRunLog {
  const entries: OwnedTailEntry[] = [
    {
      id: `${run.id}:prompt`,
      kind: 'event',
      label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
      text: compactText(run.prompt, 400),
      timestamp: run.startedAt,
      timestampLabel: formatClock(run.startedAt),
    },
  ];
  let threadId: string | undefined;
  let noiseIndex = 0;
  let completedTurn = false;

  for (const [lineIndex, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const type = String(parsed.type ?? '');
      const { timestamp, timestampLabel } = parseEntryTimestamp(parsed.timestamp, fallbackTimestamp);
      const payload = safeObject(parsed.payload);

      if (type === 'thread.started') {
        threadId = String(parsed.thread_id ?? '') || threadId;
        continue;
      }

      if (type === 'turn.started') {
        entries.push({
          id: `${run.id}:turn-start:${entries.length}`,
          kind: 'event',
          label: 'Run started',
          text: run.mode === 'launch' ? 'Owned Codex run launched from o8.' : 'Owned Codex session resumed from o8.',
          timestamp,
          timestampLabel,
        });
        continue;
      }

      if (type === 'event_msg' && payload?.type === 'agent_message') {
        const text = truncateText(
          typeof payload.message === 'string' ? payload.message : extractStructuredText(payload.content),
          500,
        );
        if (text) {
          entries.push({
            id: `${run.id}:event-message:${lineIndex}`,
            kind: 'message',
            label: payload.phase === 'commentary' ? 'Progress' : 'Assistant',
            text,
            timestamp,
            timestampLabel,
          });
        }
        continue;
      }

      if (type === 'event_msg' && payload?.type === 'task_complete') {
        completedTurn = true;
        entries.push({
          id: `${run.id}:task-complete:${lineIndex}`,
          kind: 'event',
          label: 'Task completed',
          text: 'Run completed.',
          timestamp,
          timestampLabel,
        });
        continue;
      }

      if (type === 'event_msg' && payload?.type === 'exec_command_begin') {
        const command = readStringField(payload, 'parsed_cmd', 'cmd', 'command');
        entries.push({
          id: `${run.id}:exec-begin:${lineIndex}`,
          toolCall: { id: `${run.id}:${readStringField(payload, 'call_id', 'id') ?? lineIndex}`, name: 'exec_command', args: { command }, status: 'running' },
          kind: 'tool',
          label: 'exec_command',
          text: command ? `Run ${compactText(command, 180)}` : 'Run shell command',
          timestamp,
          timestampLabel,
        });
        continue;
      }

      if (type === 'event_msg' && payload?.type === 'exec_command_end') {
        const output = toolOutputPreview(payload.aggregated_output ?? payload.output);
        {
          entries.push({
            id: `${run.id}:exec-output:${lineIndex}`,
            toolCall: { id: `${run.id}:${readStringField(payload, 'call_id', 'id') ?? lineIndex}`, name: 'exec_command', status: payload.exit_code != null && payload.exit_code !== 0 ? 'error' : 'done', result: output },
            kind: 'tool-output',
            label: 'Tool output',
            text: output,
            timestamp,
            timestampLabel,
          });
        }
        continue;
      }

      if (type === 'response_item' && (payload?.type === 'function_call' || payload?.type === 'custom_tool_call')) {
        const toolName = readStringField(payload, 'name', 'namespace', 'execution') ?? 'tool';
        const toolInput = payload.type === 'custom_tool_call' ? payload.input : payload.arguments;
        entries.push({
          id: `${run.id}:tool-call:${readStringField(payload, 'call_id', 'id') ?? lineIndex}`,
          toolCall: { id: `${run.id}:${readStringField(payload, 'call_id', 'id') ?? lineIndex}`, name: toolName, args: parseJsonObject(toolInput) ?? { input: toolInput }, status: 'running' },
          kind: 'tool',
          label: toolName,
          text: describeToolActivity(toolName, toolInput),
          timestamp,
          timestampLabel,
        });
        continue;
      }

      if (type === 'response_item' && (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output')) {
        const output = toolOutputPreview(payload.output);
        {
          entries.push({
            id: `${run.id}:tool-output:${readStringField(payload, 'call_id', 'id') ?? lineIndex}`,
            toolCall: { id: `${run.id}:${readStringField(payload, 'call_id', 'id') ?? lineIndex}`, name: 'tool', status: payload.is_error === true ? 'error' : 'done', result: output },
            kind: 'tool-output',
            label: 'Tool output',
            text: output,
            timestamp,
            timestampLabel,
          });
        }
        continue;
      }

      if (type === 'item.completed') {
        const item = safeObject(parsed.item);
        if (!item) {
          continue;
        }

        if (item.type === 'agent_message') {
          const text = truncateText(
            readStringField(item, 'text')
              ?? extractStructuredText(item.content)
              ?? extractStructuredText(item.message),
            // Completion receipts live at the end of the final assistant
            // message. A presentation-sized preview here permanently removed
            // the closing self-review block before lifecycle code could parse
            // it, even though the durable JSONL contained the full receipt.
            20_000,
          );
          if (text) {
            entries.push({
              id: `${run.id}:message:${entries.length}`,
              kind: 'message',
              label: 'Assistant',
              text,
              timestamp,
              timestampLabel,
            });
          }
          continue;
        }

        if (item.type === 'tool_use') {
          const toolName = readStringField(item, 'name', 'tool_name') ?? 'tool';
          const toolInput = item.input ?? item.arguments ?? item.invocation ?? item;
          const id = `${run.id}:tool:${readStringField(item, 'id') ?? lineIndex}`;
          const existing = entries.find(entry => entry.id === id);
          const entry: OwnedTailEntry = {
            id, kind: 'tool', label: toolName, text: describeToolActivity(toolName, toolInput),
            timestamp: existing?.timestamp ?? timestamp, timestampLabel: existing?.timestampLabel ?? timestampLabel,
            toolCall: { id: `${run.id}:${readStringField(item, 'id') ?? lineIndex}`, name: toolName,
              args: parseJsonObject(toolInput) ?? { input: toolInput }, status: item.is_error === true ? 'error' : 'done',
              result: toolOutputPreview(item.output ?? item.result) },
          };
          if (existing) Object.assign(existing, entry);
          else entries.push(entry);
          continue;
        }

        if (item.type === 'command_execution') {
          const command = String(item.command ?? '').trim();
          const output = toolOutputPreview(item.aggregated_output);
          const itemId = `${run.id}:${readStringField(item, 'id') ?? lineIndex}`;
          // Completion is a later event, not a rewrite behind a sync cursor.
          // The shared tool-call identity still folds it into the running row.
          const id = `${run.id}:tool-output:${readStringField(item, 'id') ?? lineIndex}`;
          const existing = entries.find(entry => entry.id === id);
          const entry: OwnedTailEntry = {
            id, kind: 'tool-output', label: 'Tool output', text: command ? `Run ${command}` : 'Run shell command',
            timestamp: existing?.timestamp ?? timestamp, timestampLabel: existing?.timestampLabel ?? timestampLabel,
            toolCall: { id: itemId, name: 'exec_command', args: { command },
              status: item.exit_code != null && item.exit_code !== 0 || item.status === 'failed' ? 'error' : 'done', result: output },
          };
          if (existing) Object.assign(existing, entry);
          else entries.push(entry);
          continue;
        }
      }

      if (type === 'item.started') {
        const item = safeObject(parsed.item);
        if (item?.type === 'command_execution') {
          const command = String(item.command ?? '').trim();
          entries.push({
            id: `${run.id}:tool:${readStringField(item, 'id') ?? lineIndex}`,
            kind: 'tool',
            label: 'exec_command',
            toolCall: { id: `${run.id}:${readStringField(item, 'id') ?? lineIndex}`, name: 'exec_command', args: { command }, status: 'running' },
            text: command ? `Running ${compactText(command, 180)}` : 'Running shell command',
            timestamp,
            timestampLabel,
          });
          continue;
        }
        if (item?.type === 'tool_use') {
          const toolName = readStringField(item, 'name', 'tool_name') ?? 'tool';
          const toolInput = item.input ?? item.arguments ?? item.invocation ?? item;
          entries.push({
            id: `${run.id}:tool:${readStringField(item, 'id') ?? lineIndex}`,
            toolCall: { id: `${run.id}:${readStringField(item, 'id') ?? lineIndex}`, name: toolName, args: parseJsonObject(toolInput) ?? { input: toolInput }, status: 'running' },
            kind: 'tool',
            label: toolName,
            text: describeToolActivity(toolName, toolInput),
            timestamp,
            timestampLabel,
          });
          continue;
        }
      }

      if (type === 'turn.completed') {
        completedTurn = true;
        const usage = (parsed.usage ?? {}) as Record<string, unknown>;
        const assistant = [...entries].reverse().find(entry => entry.kind === 'message' && !entry.label.toLowerCase().includes('user'));
        if (assistant) { assistant.model = reportedRunModel(raw); assistant.tokens = observedCacheTokens(usage, true); assistant.timestamp = run.finishedAt ?? timestamp; }
        const usageBits = [
          usage.input_tokens ? `${usage.input_tokens} in` : null,
          usage.cached_input_tokens ? `${usage.cached_input_tokens} cached` : null,
          usage.output_tokens ? `${usage.output_tokens} out` : null,
        ].filter(Boolean);
        entries.push({
          id: `${run.id}:turn-complete:${entries.length}`,
          kind: 'event',
          label: 'Turn completed',
          text: usageBits.length ? `Usage • ${usageBits.join(' • ')}` : 'Run completed.',
          timestamp,
          timestampLabel,
        });
        continue;
      }
    } catch {
      entries.push({
        id: `${run.id}:noise:${noiseIndex += 1}`,
        kind: 'event',
        label: 'Runtime',
        text: compactText(trimmed, 500),
        timestamp: run.finishedAt ?? run.startedAt,
        timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
      });
    }
  }

  const outcome = run.outcome === 'running'
    ? completedTurn
      ? 'finished'
      : run.interruptRequestedAt
        ? 'interrupted'
        : 'running'
    : run.outcome;

  return {
    threadId,
    entries,
    outcome,
    completedTurn,
  };
}
