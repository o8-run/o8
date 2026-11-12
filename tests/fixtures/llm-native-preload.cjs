// Deterministic provider transport, confined to the fixture's owned child process.
const realFetch = globalThis.fetch;
process.env.OPENAI_API_KEY = 'llm-fixture-provider-secret';
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.openai.com/v1/chat/completions') return realFetch(url, init);
  const body = JSON.parse(init.body);
  if (body.model === 'fixture-error') return new Response(process.env.OPENAI_API_KEY, { status: 502 });
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"second"}}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      }, 1000);
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
};
