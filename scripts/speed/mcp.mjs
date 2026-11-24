import { distribution, round } from './common.mjs';

let id = 0;
export async function rpc(stack, method, params = {}) {
  const started = performance.now();
  const requestId = ++id;
  const response = await fetch(`${stack.base}/api/mcp`, { method: 'POST',
    headers: { Authorization: `Bearer ${stack.token}`, 'Content-Type': 'application/json', 'x-o8-mcp-profile': 'full' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(180000) });
  const text = await response.text();
  const ms = round(performance.now() - started);
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const value = JSON.parse(text);
  if (value.jsonrpc !== '2.0' || value.id !== requestId || (!value.error && !Object.hasOwn(value, 'result'))) throw new Error('Malformed MCP response');
  if (value.error || value.result?.isError) throw new Error(`MCP failure: ${JSON.stringify(value.error ?? value.result).slice(0, 600)}`);
  return { ms, bytes: Buffer.byteLength(text), result: value.result };
}
export async function tool(stack, name, args = {}) {
  const value = await rpc(stack, 'tools/call', { name, arguments: args });
  const text = value.result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
  try { return { ...value, data: JSON.parse(text) }; } catch { return { ...value, data: text }; }
}
export async function measureMcp(stack, repoPath, samples = 30) {
  const catalog = await rpc(stack, 'tools/list');
  const names = new Set(catalog.result.tools.map(tool => tool.name));
  const selected = ['o8_status', 'get_mission_status', 'o8_task_list', 'o8_operator_defaults',
    'o8_list_repos', 'o8_list_projects', 'o8_msg_agents', 'o8_problem_list'];
  const result = [{ name: 'tools/list', firstCallMs: catalog.ms, bytes: catalog.bytes }];
  for (const name of selected) {
    if (!names.has(name)) throw new Error(`Required read tool absent: ${name}`);
    const first = await tool(stack, name, name === 'o8_msg_agents' ? { repo: repoPath } : {});
    result.push({ name, firstCallMs: first.ms, bytes: first.bytes });
  }
  // Interleave tools to avoid attributing a single warm-up burst to one tool.
  const readings = result.map(() => []);
  for (let i = 0; i < samples; i++) for (let j = 0; j < result.length; j++) {
    const name = result[j].name;
    const value = j === 0 ? await rpc(stack, 'tools/list') : await tool(stack, name, name === 'o8_msg_agents' ? { repo: repoPath } : {});
    readings[j].push(value.ms);
  }
  return result.map((entry, i) => ({ ...entry, ms: distribution(readings[i]) }));
}
