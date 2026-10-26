import { redactSensitiveTranscriptText } from '@/components/desktop/transcript-sanitize';
import type { ThreadEvidence } from './types';

const credentialField = '(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token)';
const credentialKey = new RegExp(`^${credentialField}$`, 'i');
const quotedCredential = new RegExp(String.raw`("${credentialField}"\s*:\s*)"(?:\\.|[^"\\])*"`, 'gi');

export function redactThreadValue(value: unknown): unknown {
  if (typeof value === 'string') return redactThreadText(value);
  if (Array.isArray(value)) return value.map(redactThreadValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    redactThreadText(key), credentialKey.test(key) ? '[redacted]' : redactThreadValue(item),
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
