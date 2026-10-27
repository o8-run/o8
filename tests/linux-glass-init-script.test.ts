import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

let root: string;
const binaries = new Map<boolean, string>();
const port = 43127;
const bootId = 'boot-fixture';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-linux-glass-init-'));
  const source = readFileSync(join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');
  const marker = source.indexOf('let html_traffic_lights = cfg!');
  const start = source.indexOf('let init_script = format!(', marker);
  const end = source.indexOf('tauri::WebviewWindowBuilder::from_config', start);
  expect(start).toBeGreaterThan(marker);
  expect(end).toBeGreaterThan(start);
  // Compile the actual production statements, mocking only target cfg and
  // the OS constant. The JSON shim serializes this ASCII boot-id fixture.
  const statements = source.slice(start, end)
    .replaceAll('std::env::consts::OS', 'host_os')
    .replaceAll('target_os = "linux"', 'o8_probe_linux');
  const harness = `
mod serde_json {
    pub fn to_string(value: &str) -> Result<String, ()> { Ok(format!("{value:?}")) }
}
struct BootIdentity { boot_id: String }
fn render(host_os: &str, api_port: u16) -> String {
    let boot_identity = BootIdentity { boot_id: "${bootId}".into() };
    let html_traffic_lights = host_os == "macos";
    ${statements}
    init_script
}
fn main() {
    let host = std::env::args().nth(1).expect("host");
    print!("{}", render(&host, ${port}));
}
`;
  const rust = join(root, 'init.rs'); writeFileSync(rust, harness);
  for (const linux of [false, true]) {
    const binary = join(root, `init-${linux ? 'linux' : 'other'}${process.platform === 'win32' ? '.exe' : ''}`);
    execFileSync(process.env.RUSTC ?? 'rustc', ['--edition=2021', rust, '-o', binary,
      ...(linux ? ['--cfg', 'o8_probe_linux'] : [])], { encoding: 'utf8', timeout: 30_000 });
    binaries.set(linux, binary);
  }
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function render(linux: boolean, host: string, optIn?: string) {
  return execFileSync(binaries.get(linux)!, [host], { encoding: 'utf8', timeout: 5_000,
    env: { NODE_ENV: 'test', O8_LINUX_GLASS: optIn, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
}
function mainScript(host: string) {
  return `window.__O8_PORT_HINT__ = ${port}; window.__O8_EXPECTED_BOOT_ID__ = ${JSON.stringify(bootId)}; window.__O8_HTML_TRAFFIC_LIGHTS__ = ${host === 'macos'}; window.__O8_HOST_PLATFORM__ = ${JSON.stringify(host)};`;
}

it.each(['macos', 'windows'])('keeps %s initialization script byte-identical to main', host => {
  expect(render(false, host, '1')).toBe(mainScript(host));
});
it.each([undefined, '0', '1', ' 1 '])('preserves the Linux glass opt-in stamp for %s', optIn => {
  expect(render(true, 'linux', optIn)).toBe(`${mainScript('linux')} window.__O8_LINUX_GLASS__ = ${optIn?.trim() === '1'};`);
});
