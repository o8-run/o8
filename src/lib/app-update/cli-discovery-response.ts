import type { CliUpdateRecord } from '@/lib/setup/cli-updates';

export interface CliDiscoveryProgress { completed: number; total: number }

/** Discovery can return rows while other version probes are still pending. */
export async function readCliDiscoveryResponse(response: Response, report: {
  progress: (progress: CliDiscoveryProgress) => void;
  tool: (tool: CliUpdateRecord) => void;
}): Promise<CliUpdateRecord[]> {
  const unavailable = 'CLI update checks are unavailable.';
  if (!response.ok) throw new Error(unavailable);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const payload = await response.json() as { tools?: CliUpdateRecord[] };
    if (!Array.isArray(payload.tools)) throw new Error(unavailable);
    return payload.tools;
  }
  if (!response.body) throw new Error(unavailable);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: CliUpdateRecord[] | undefined;
  const apply = (frame: string) => {
    const lines = frame.split('\n');
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const payload = JSON.parse(data) as Partial<CliDiscoveryProgress> & { tool?: CliUpdateRecord; tools?: CliUpdateRecord[]; error?: string };
    if (event === 'error') throw new Error(payload.error ?? unavailable);
    if (event === 'progress' || event === 'tool') {
      if (typeof payload.completed === 'number' && typeof payload.total === 'number') {
        report.progress({ completed: payload.completed, total: payload.total });
      }
    }
    if (event === 'tool' && payload.tool?.runtimeId) report.tool(payload.tool);
    if (event === 'result') {
      if (!Array.isArray(payload.tools)) throw new Error(unavailable);
      result = payload.tools;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll('\r\n', '\n');
      let end = buffer.indexOf('\n\n');
      while (end >= 0) { apply(buffer.slice(0, end)); buffer = buffer.slice(end + 2); end = buffer.indexOf('\n\n'); }
      if (result) return result;
      if (done) {
        if (buffer.trim()) apply(buffer);
        if (result) return result;
        throw new Error('Tool discovery stopped before the report finished. Retry.');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
