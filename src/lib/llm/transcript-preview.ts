export function summarizeTranscript(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}
