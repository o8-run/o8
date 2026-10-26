// Use the host's real native PTY; stub only the login CLI's host gate.
require('node-pty');
if (process.platform !== 'darwin') Object.defineProperty(process, 'platform', { value: 'darwin' });
