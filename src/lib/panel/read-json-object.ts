/** Required JSON object bodies share one parser and shape check. Routes retain their error envelope. */
export async function readJsonObject<T extends object = Record<string, unknown>>(request: Pick<Request, 'json'>): Promise<T | null> {
  const body: unknown = await request.json().catch(() => null);
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as T : null;
}
