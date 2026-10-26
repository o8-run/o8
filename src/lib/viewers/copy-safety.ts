/** The wire mask is reserved display content, independent of live credentials. */
export function isMaskedViewerReplay(source: string, submitted: string): boolean {
  return submitted.includes('[redacted]') && submitted !== source;
}
