import { DeviceControllers } from './controllers';
import { subscribeControllers } from './controller-events';

export function controllerStream(root: string, signal: AbortSignal): Response {
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      const unsubscribe = subscribeControllers(root, send);
      const timer = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 15_000);
      cleanup = () => { unsubscribe(); clearInterval(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); controller.close(); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else send(new DeviceControllers(root).snapshot());
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer' } });
}
