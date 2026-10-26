/** Shared credential patterns for output, viewer transport and telemetry. */
export const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted]'],
  [/\b(Bearer|Basic)\s+[^\s"'\\,;]+/gi, '$1 [redacted]'],
  [/\bo8d_[A-Za-z0-9_-]+/g, 'o8d_[redacted]'],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]+/g, '$1_$2_[redacted]'],
  [/([?&#;]code=)[^&#\s"'\\]+/gi, '$1[redacted]'],
  [/(?<![A-Za-z0-9_-])([A-Za-z0-9_-]*(?:token|ticket|jwt|session|secret|passw(?:or)?d|authorization|cookie|api[_-]?key|credential)[A-Za-z0-9_-]*)(\\*["']?\s*[:=]\s*\\*["']?)([^"'\\\s&#,;{}()[\]]+)/gi, '$1$2[redacted]'],
];

export const CREDENTIAL_KEY = '(?<![A-Za-z0-9_-])[A-Za-z0-9_-]*(?:token|ticket|jwt|session|secret|passw(?:or)?d|authorization|cookie|api[_-]?key|credential)[A-Za-z0-9_-]*';
const KEY = CREDENTIAL_KEY;
const VALUE = '(?:"(?:\\\\.|[^"\\\\])*(?:"|$)|\'(?:\\\\.|[^\'\\\\])*(?:\'|$)|`(?:\\\\.|[^`\\\\])*(?:`|$)|[^\\s;]+)';

export const VIEWER_SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Quoted values may contain whitespace and escaped delimiters.
  [new RegExp('(' + KEY + '["\']?\\s*[:=]\\s*)(["\'`])(?:\\\\.|(?!\\2)[^\\\\])*?(?:\\2|$)', 'gi'), '$1$2[redacted]$2'],
  // Literal computed environment keys cannot hide behind concatenation.
  [new RegExp(String.raw`(\bprocess\s*\.\s*env\s*\[(?:\s*(?:'[^'\r\n]*'|"[^"\r\n]*")\s*\+?)+\]\s*=\s*)` + VALUE, 'gi'), '$1"[redacted]"'],
  [new RegExp(String.raw`(?<!\S)((?:--user(?:\s+|=)|-u\s*)|--(?:password|token|api-key)(?:\s+|=))` + VALUE, 'gi'), '$1[redacted]'],
  [/\b(?:o8sp|o8pw|cwk)_[A-Za-z0-9_-]{12,}\b/g, '[redacted]'],
  [/\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[redacted]'],
  [/[?&](?:auth|authorization|key)=[^&\s"']+/gi, '[redacted]'],
  [/:\/\/[^\s/:]+:[^\s/@]+@/g, '://[redacted]@'],
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, '[redacted]'],
];

/** Display reads fail closed on incomplete syntax and concatenated values. */
export const CREDENTIAL_LINE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [new RegExp(KEY + '["\']?\\s*[:=][^\\r\\n]*', 'gi'), '[redacted]'],
  [/\bprocess\s*\.\s*env\s*\[[^\r\n\]]+\]\s*=[^\r\n]*/gi, '[redacted]'],
  [/(?<!\S)(?:--(?:user|password|token|api-key)(?:\s+|=)|-u\s*)[^\r\n]*/gi, '[redacted]'],
];
