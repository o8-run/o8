/** Stable public failure reasons; child/browser diagnostics stay in local logs. */
export class CaptureError extends Error {
  constructor(reason, diagnostic = reason) {
    super(diagnostic);
    this.reason = reason;
  }
}

export function isAppBundle(source, origin) {
  if (/^(webpack-internal:|turbopack:)/.test(source) || /(?:^|\/)src\//.test(source)) return true;
  try {
    const url = new URL(source);
    return url.origin === origin && (url.pathname.startsWith('/_next/') || /\.[cm]?js$/.test(url.pathname));
  } catch { return false; }
}

export function nativeErrorText(text) {
  return /local server unavailable|targets unavailable|terminal attachment failed|terminal input unavailable|could not (?:reach|load)|failed to (?:load|connect)|\bHTTP\s*[:(]?\s*[45]\d\d\b/i.test(text)
    || /^(?:error|application error|render(?:ing)? (?:error|failed))\s*[:.!]?\s*$/im.test(text);
}
