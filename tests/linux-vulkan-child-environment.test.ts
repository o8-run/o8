import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { assertVulkanInventory } from '../scripts/linux/bundle-vulkan.mjs';

it('routes every native child command through the shared environment boundary', () => {
  const root = resolve('native/o8-next/src');
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? files(join(dir, entry.name)) : entry.name.endsWith('.rs') ? [join(dir, entry.name)] : []);
  }
  const bypasses = files(root).filter(file => !['child_command.rs', 'external_open.rs'].includes(file.slice(root.length + 1)))
    .filter(file => !/(?:_tests|test_support|\/tests)\.rs$/.test(file))
    .filter(file => /\bCommand\s*::\s*new\s*\(|\b(?:cx|app)\.(?:open_url|open_with_system|reveal_path|restart)\s*\(/.test(readFileSync(file, 'utf8').split('#[cfg(test)]\nmod tests {')[0]));
  expect(bypasses).toEqual([]);
});

it('rejects licence inventory path, size and licence drift from the manifest', () => {
  const notice = '### Bundled file inventory\n| `usr/lib/o8/vulkan/driver.so` | 123 | MIT |\n';
  const valid = [{ name: 'usr/lib/o8/vulkan/driver.so', bytes: 123, license: 'MIT' }];
  expect(() => assertVulkanInventory(notice, valid)).not.toThrow();
  for (const change of [{ bytes: 124 }, { name: 'usr/lib/o8/vulkan/other.so' }, { license: 'BSD' }]) {
    expect(() => assertVulkanInventory(notice, [{ ...valid[0], ...change }])).toThrow('inventory differs');
  }
  expect(() => assertVulkanInventory(notice, [])).toThrow('inventory differs');
});
