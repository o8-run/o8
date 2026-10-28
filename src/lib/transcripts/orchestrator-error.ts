/** Select the diagnostic before applying any transcript/display limit. */
export function orchestratorErrorText(
  diagnostic: string,
  fallback = 'Error: Orchestrator turn failed',
  preferLine?: (line: string) => boolean,
): string {
  // Node can color stack frames even when the bridge's protocol is plain JSON.
  const lines = diagnostic.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const sourceLines = new Set<number>();
  const errorHeader = /^\s*(?:[\w.$]*(?:Error|Exception))(?: \[[^\]]+\])?:/;
  let afterCaret = -1;
  for (let index = 0; index < lines.length; index += 1) {
    // Includes node:internal, relative paths and other non-file URL schemes.
    if (/^(?:[A-Za-z]:[\\/].+|[\\/].+|\S+):\d+(?::\d+)?$/.test(lines[index].trim())) {
      sourceLines.add(index);
      sourceLines.add(index + 1);
      if (/^\s*\^/.test(lines[index + 2] ?? '')) afterCaret = index + 3;
    }
  }
  // Prefixes still need a location. V8's Promise.all index frames are explicit
  // synthetic frames, rather than arbitrary locationless async message lines.
  const isV8Frame = (line: string) => /^\s*at\s+(?:(?:(?:async|new)\s+)?(?:<anonymous>|node:internal\S*|.+ \([^()\r\n]+:\d+:\d+\)|[^()\r\n]+:\d+:\d+)|async Promise\.all \(index \d+\))\s*$/.test(line);
  const isBoundary = (line: string, index: number) => sourceLines.has(index) || isV8Frame(line)
    || /^\s*(?:\^|Node\.js v\d|\(Use `node --trace-uncaught)/.test(line);
  const isCandidate = (line: string, index: number) => line.trim() && !isBoundary(line, index);
  let start = preferLine ? lines.findIndex((line, index) => isCandidate(line, index) && preferLine(line)) : -1;
  if (start < 0 && afterCaret >= 0) {
    // The message need not have an Error class: Node also prints strings/objects.
    start = lines.findIndex((line, index) => index >= afterCaret && isCandidate(line, index));
  }
  if (start < 0) start = lines.findIndex((line, index) => isCandidate(line, index) && errorHeader.test(line));
  if (start < 0) {
    // Incomplete frames must never fall back to source.
    if (sourceLines.size) return fallback;
    start = lines.findIndex(line => line.trim());
    if (start < 0 || isV8Frame(lines[start]) || /^(?:file:\/\/|\^|var\b|const\b|let\b|throw\b|function\b|import\b|export\b)/.test(lines[start].trim())) return fallback;
  }
  let end = start + 1;
  for (; end < lines.length && !isBoundary(lines[end], end); end += 1) {
    // The bridge prints its contextual summary before the original Error stack.
    if (errorHeader.test(lines[end]) && isV8Frame(lines[end + 1] ?? '')) break;
  }
  return lines.slice(start, end).join('\n').trim() || fallback;
}
