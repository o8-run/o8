import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import next from 'next';

// Keep optional background jobs out of this isolated HTTP fixture.
globalThis.__o8NextStartupScheduled = true;
process.env.NEXT_PHASE = 'phase-production-build';
const app = next({ dev: true, hostname: '127.0.0.1', port: Number(process.env.PORT) });
await app.prepare();
const handle = app.getRequestHandler();
const handleRequest = (req, res) => {
  if (req.url === '/fixture-parent') {
    res.setHeader('content-type', 'text/html');
    res.end(readFileSync(process.env.PREVIEW_PARENT_FILE));
  } else if (req.url === '/fixture-refresh-app') {
    res.setHeader('content-type', 'text/html');
    res.setHeader('set-cookie', '__session=replaced; HttpOnly; Path=/');
    res.end('<html><body>application fixture</body></html>');
  } else {
    void handle(req, res);
  }
};
createServer(handleRequest).listen(Number(process.env.PORT), '::1');
createServer(handleRequest).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('[preview-next] preview-next-ready'));
