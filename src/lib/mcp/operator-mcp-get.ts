// GET has no stream or tool-host state. Keep its canonical refusal cold.
export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
}
