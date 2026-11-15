// Stands in for the WS server: answers /health, then writes to stderr and exits on its own,
// the way a listener that dies mid-test does.
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200).end('ok');
    setTimeout(() => {
      process.stderr.write('fixture listener failure: simulated crash\n');
      process.exit(3);
    }, Number(process.env.FIXTURE_EXIT_DELAY_MS ?? 50));
    return;
  }
  response.writeHead(404).end();
});
server.listen(Number(process.env.O8_WS_PORT), '127.0.0.1');
