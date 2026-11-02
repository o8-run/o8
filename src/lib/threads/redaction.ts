import { redactSensitiveTranscriptText } from '@/components/desktop/transcript-sanitize';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { ThreadEvidence } from './types';

const credentialField = '(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|secret[_-]?key|credentials?|cookie|secret|password|passwd|token)';
// Whole name or its last `_`/`-`/`.`/camelCase segment: OPENAI_API_KEY, X-Api-Key, githubToken; not max_tokens.
const credentialKey = new RegExp(`(?:^|[_.\\s-])${credentialField}$`, 'i');
const isCredentialKey = (key: string) => credentialKey.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
const quotedCredential = new RegExp(String.raw`("(?:[A-Za-z0-9]+[_.-]){0,6}${credentialField}"\s*:\s*)"(?:\\.|[^"\\])*"`, 'gi');

export function redactThreadValue(value: unknown): unknown {
  if (typeof value === 'string') return redactThreadText(value);
  if (Array.isArray(value)) return value.map(redactThreadValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    redactThreadText(key), isCredentialKey(key) ? '[redacted]' : redactThreadValue(item),
  ]));
  return value;
}

/** Display content only: routing paths, record IDs and session identities stay exact. */
export function redactThreadText(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object') {
      const safe = redactThreadValue(value);
      if (JSON.stringify(value) !== JSON.stringify(safe)) return JSON.stringify(safe);
    }
  } catch { /* Prose and HTML still use the transcript policy below. */ }
  return redactSensitiveTranscriptText(text.replace(quotedCredential, '$1"[redacted]"'))
    .replace(/\/Users\/[^/\s<>"']+(?=\/|\b)/g, '~')
    .replace(/\/home\/[^/\s<>"']+(?=\/|\b)/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s<>"']+(?=\\|\b)/g, '~');
}

/**
 * Tool args and command output can carry credentials and home paths. Every
 * canonical chat-history write applies this, server-originated or client POST.
 */
export function redactToolCallForRest(tool: MobileTranscriptToolCall): MobileTranscriptToolCall {
  // Client JSON is untrusted: a malformed entry is stored as before, never a 500.
  if (!tool || typeof tool !== 'object') return tool;
  return {
    ...tool,
    ...(tool.args !== undefined ? { args: redactThreadValue(tool.args) as Record<string, unknown> } : {}),
    ...(tool.result !== undefined ? { result: redactThreadValue(tool.result) as string } : {}),
    ...(tool.preview !== undefined ? { preview: redactThreadValue(tool.preview) as string } : {}),
  };
}

export function redactThreadEvidence(evidence: ThreadEvidence): ThreadEvidence {
  return { ...evidence,
    requirements: evidence.requirements.map(item => ({ ...item, text: redactThreadText(item.text), verification: redactThreadText(item.verification) })),
    artifacts: evidence.artifacts.map(item => ({ ...item, title: redactThreadText(item.title) })),
    merges: evidence.merges.map(item => ({ ...item, title: redactThreadText(item.title) })),
    workers: evidence.workers.map(item => ({ ...item, name: redactThreadText(item.name), model: item.model ? redactThreadText(item.model) : item.model })),
    stages: evidence.stages.map(item => ({ ...item, name: redactThreadText(item.name) })),
    history: evidence.history.map(item => ({ ...item, label: redactThreadText(item.label) })),
  };
}

export function redactThreadDisplay<T extends { title: string; summary?: string; blockedReason?: string | null; lastEventLabel?: string | null; thread?: ThreadEvidence }>(task: T): T {
  return { ...task, title: redactThreadText(task.title),
    ...(task.summary !== undefined ? { summary: redactThreadText(task.summary) } : {}),
    ...(task.blockedReason ? { blockedReason: redactThreadText(task.blockedReason) } : {}),
    ...(task.lastEventLabel ? { lastEventLabel: redactThreadText(task.lastEventLabel) } : {}),
    ...(task.thread ? { thread: redactThreadEvidence(task.thread) } : {}),
  };
}
