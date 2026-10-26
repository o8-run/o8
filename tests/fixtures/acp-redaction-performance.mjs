import module from '../../src/lib/acp/output-redaction.ts';
const { createAcpOutputRedactor } = module;
const size = Number(process.argv[2]);
const unit = String.raw`\u0062\n`;
const value = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const secrets = [String.raw`synthetic-\u0061-credential`, String.raw`synthetic-\n-credential`];
const cpu = process.cpuUsage();
const start = performance.now();
const result = createAcpOutputRedactor(secrets).redact(value);
const used = process.cpuUsage(cpu);
process.stdout.write(JSON.stringify({ size, unchanged: result === value,
  wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000 }));
