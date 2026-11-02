import './stdio-console';
import { createInterface } from 'node:readline';
import type { OperatorMcpRequest } from './operator-mcp-host';
import { handleNetworkMcpMessage } from './network-mcp-host';
import { requireNetworkMcpBinding } from '@/lib/bots/network-mcp-service';

export function startNetworkMcpStdio() {
  const bindingId = process.env.O8_NETWORK_BINDING_ID ?? '';
  requireNetworkMcpBinding(bindingId);
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', line => {
    if (!line.trim()) return;
    let message: OperatorMcpRequest;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
        send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return;
      }
      message = value;
    } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    void handleNetworkMcpMessage(message, bindingId).then(response => { if (response) send(response); })
      .catch(() => send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: 'Local network request failed' } }));
  });
  input.on('close', () => process.exit(0));
}
