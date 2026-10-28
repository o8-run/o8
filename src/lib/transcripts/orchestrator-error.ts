/** Select the diagnostic before applying any transcript/display limit. */
export function orchestratorErrorText(
  diagnostic: string,
  fallback = 'Error: Orchestrator turn failed',
  preferLine?: (line: string) => boolean,
): string {
  // Node can color stack frames even when the bridge's protocol is plain JSON.
  const lines = diagnostic.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const sourceLines = new Set<number>();
  let hasFrame = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^(?:file:\/\/\S+|(?:[A-Za-z]:)?[\\/].+|[^\s:]+\.[cm]?[jt]s):\d+(?::\d+)?$/.test(lines[index].trim())) {
      hasFrame = true;
      sourceLines.add(index);
      sourceLines.add(index + 1);
    }
  }
  const candidates = lines.filter((line, index) => !sourceLines.has(index) && !/^\s*(?:\^|at\s)/.test(line));
  const error = (preferLine && candidates.find(preferLine))
    || candidates.find(line => /^\s*(?:[\w.$]*(?:Error|Exception))(?: \[[^\]]+\])?:/.test(line));
  if (error) return error.trim();
  // Incomplete frames and thrown non-Errors must never fall back to source.
  if (hasFrame) return fallback;
  const first = lines.find(line => line.trim())?.trim();
  if (!first || /^(?:file:\/\/|at\s|\^|var\b|const\b|let\b|throw\b|function\b|import\b|export\b)|[;{}]/.test(first)) return fallback;
  return first;
}
