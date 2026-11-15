import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/** Node fetch limits response headers to 300s. Dispatch can await a longer launch. */
export function forwardLongNativeRequest(url: string, request: Request, headers: Headers, body?: ArrayBuffer): Promise<Response> {
  return new Promise((resolve, reject) => {
    const send = url.startsWith('https:') ? httpsRequest : httpRequest;
    const outgoing = send(url, { method: request.method, headers: Object.fromEntries(headers), signal: request.signal }, incoming => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status: incoming.statusCode, headers: responseHeaders }));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(0);
    outgoing.end(body ? Buffer.from(body) : undefined);
  });
}
