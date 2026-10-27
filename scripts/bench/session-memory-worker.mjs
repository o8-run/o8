// Offline worker output: exercise the persisted run-log reader without a provider.
const [index, sizeMiB] = process.argv.slice(2).map(Number);
for (let row = 0; row < 32; row++) {
  const pattern = `${index}-${row}-worker `;
  const length = Math.floor(sizeMiB * 1024 * 1024 / 32);
  const text = `worker-output-${row}:` + pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: {
    id: `output-${row}`, type: 'agent_message', text,
  } }) + '\n');
}
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
