/** Standalone Node proxy; contains no runtime credentials or native dependencies. */
export const MCP_BROKER_CLIENT = String.raw`
const fs = require('node:fs'), net = require('node:net');
const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
let socket, timer, settled = false, ready = false, input = '';
const fail = () => { if (settled) return; settled = true; clearTimeout(timer); socket?.destroy(); process.stdin.destroy(); process.stderr.write('MCP launch unavailable or refused.\n'); process.exitCode = 1; };
const deadline = Date.now() + 5000;
function connect() {
  let fd, descriptor;
  try {
    fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & 63))) throw new Error();
    descriptor = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && Date.now() < deadline) { setTimeout(connect, 20); return; }
    fail(); return;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (descriptor.version !== 1 || descriptor.host !== '127.0.0.1' || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[a-f0-9]{64}$/.test(descriptor.token)) { fail(); return; }
  socket = net.connect({host:descriptor.host, port:descriptor.port, allowHalfOpen:true});
  timer = setTimeout(fail, 5000);
  socket.on('data',chunk => {
    input += decoder.write(chunk);
    if (Buffer.byteLength(input) > 4 * 1024 * 1024) { fail(); return; }
    for (let newline = input.indexOf('\n'); newline >= 0; newline = input.indexOf('\n')) {
      const line = input.slice(0,newline); input = input.slice(newline+1);
      let reply; try { reply = JSON.parse(line); } catch { fail(); return; }
      if (!ready) {
        if (reply.ready !== true) { fail(); return; }
        ready = true; clearTimeout(timer); process.stdin.pipe(socket);
      } else if (reply.type === 'stdout' && typeof reply.text === 'string') {
        if (!process.stdout.write(reply.text)) { socket.pause(); process.stdout.once('drain',()=>socket.resume()); }
      } else if (reply.type === 'exit' && Number.isInteger(reply.code)) {
        settled = true; process.exitCode = reply.code === 0 ? 0 : 1; process.stdin.destroy(); socket.end();
      } else { fail(); return; }
    }
  });
  socket.on('connect',()=>socket.write(JSON.stringify({token:descriptor.token})+'\n'));
  socket.on('error',fail);
  socket.on('close',()=>{ clearTimeout(timer); if (!settled) fail(); process.stdin.destroy(); });
}
connect();
`;
