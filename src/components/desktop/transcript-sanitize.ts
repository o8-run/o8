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
  next = next.replace(/(\bAuthorization\s*:\s*)(Basic|Token)\s+[A-Za-z0-9+/=._~-]{8,}/gi, '$1$2 [redacted]');
  next = next.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted]');
  // `_` and `-` are word characters to `\b`, so env-style names (OPENAI_API_KEY=,
  // X-Api-Key:) need their prefix matched explicitly. The name stays readable.
  next = next.replace(/\b((?:[A-Za-z0-9]+[_-]){0,6}(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|secret|password|passwd|token))\b(\s*[:=]\s*)(["']?)[^\s"'`]+/gi, '$1$2$3[redacted]');
  next = next.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token|auth|authorization|key)=)([^&\s]+)/gi, '$1[redacted]');
  next = next.replace(/(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,256}:)[^\s/@]{1,256}@/gi, '$1[redacted]@');
  next = next.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[redacted]');
  next = next.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprse]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[0-9A-Za-z\-_]{20,})\b/g, '[redacted]');
  return next;
}

export function sanitizeTranscriptText(text: string) {
  return redactSensitiveTranscriptText(stripInternalProtocolMarkup(collapseInternalSelfReview(collapseInternalTaskPayload(text))));
}
