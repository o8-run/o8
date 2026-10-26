const INTERNAL_PROTOCOL_TAGS = [
  /<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>/gi,
  /<<<END_UNTRUSTED_CHILD_RESULT>>>/gi,
  /<\/?[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+[^>]*>/gi,
  /<\/?(?:command-name|local-command-(?:stdout|stderr|input|result)|task-notification|task-completion-event|runtime-context|begin-untrusted-child-result|end-untrusted-child-result|untrusted-child-result|task-event|command-output|command-result|status|summary|task|source|action)[^>]*>/gi,
];

function stripInternalProtocolMarkup(text: string) {
  return INTERNAL_PROTOCOL_TAGS.reduce((next, pattern) => next.replace(pattern, ' '), text);
}

function collapseInternalTaskPayload(text: string) {
  if (!/<(?:status|summary|task|source|action)>/i.test(text)) return text;

  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.trim();
  const status = text.match(/<status>([\s\S]*?)<\/status>/i)?.[1]?.trim();
  const task = text.match(/<task>([\s\S]*?)<\/task>/i)?.[1]?.trim();

  if (summary) {
    if (status && !summary.toLowerCase().includes(status.toLowerCase())) {
      return `${summary} (${status})`;
    }
    return summary;
  }

  if (task && status) return `${task} (${status})`;
  return text;
}

function collapseInternalSelfReview(text: string) {
  return text.replace(/\s*<self-review>\s*([\s\S]*?)\s*<\/self-review>\s*/gi, (_match, raw: string) => {
    try {
      const parsed = JSON.parse(raw) as { summary?: unknown };
      return typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    } catch {
      return '';
    }
  });
}

export function redactSensitiveTranscriptText(text: string) {
  let next = text;
  next = next.replace(/(\bAuthorization\s*:\s*)Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1Bearer [redacted]');
  next = next.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [redacted]');
  next = next.replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token)\b(\s*[:=]\s*)([^\s"'`]+)/gi, '$1[redacted]');
  next = next.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token|auth|authorization|key)=)([^&\s]+)/gi, '$1[redacted]');
  next = next.replace(/\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[0-9A-Za-z\-_]{20,})\b/g, '[redacted]');
  return next;
}

export function sanitizeTranscriptText(text: string) {
  return redactSensitiveTranscriptText(stripInternalProtocolMarkup(collapseInternalSelfReview(collapseInternalTaskPayload(text))));
}
