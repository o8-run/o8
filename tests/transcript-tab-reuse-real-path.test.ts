import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { webkit } from 'playwright-core';
import { expect, it } from 'vitest';

const directory = process.env.O8_TRANSCRIPT_REUSE_PROOF_DIR ?? process.env.CORTEX_IDE_DATA_DIR!;
async function measure(engine: string, control = false, options: { name?: string; env?: NodeJS.ProcessEnv } = {}) {
  await mkdir(directory, { recursive: true });
  const name = options.name ?? `${engine}${control ? '-control' : ''}`;
  const receipt = join(directory, `${name}.json`);
  await rm(receipt, { force: true });
  let failed = false;
  let stderr = '';
  try {
    const result = await promisify(execFile)(process.execPath, ['scripts/bench/interactions/transcript-tab-reuse.mjs',
      `--engine=${engine}`, '--expect-reuse', `--output=${receipt}`, `--screenshot=${join(directory, `${name}.png`)}`,
      ...(control ? ['--force-row-invalidation'] : []),
    ], { timeout: 90000, env: options.env });
    stderr = result.stderr;
  } catch (error) {
    failed = true;
    stderr = String((error as { stderr?: string }).stderr ?? error);
  }
  try {
    return { failed, receipt: JSON.parse(await readFile(receipt, 'utf8')) };
  } catch (error) {
    throw new Error(`${name} benchmark did not produce a readable receipt.\n${stderr || 'No stderr was captured.'}`, { cause: error });
  }
}
// Match the other browser tests: WebKit requires its optional Playwright binary.
for (const engine of ['chromium', 'webkit']) it.runIf(engine !== 'webkit' || existsSync(webkit.executablePath()))(
  `reuses historical turns while retaining scroll and live output in ${engine}`, async () => {
  const { failed, receipt } = await measure(engine);
  expect(receipt.errors).toEqual([]);
  expect(receipt.observations.map((value: { closedRowRenders: number }) => value.closedRowRenders)).toEqual([0, 0, 0]);
  expect(receipt).toMatchObject({ passed: true, retained: true, draftRetained: true, selectionRetained: true });
  expect(failed).toBe(false);
}, 120000);
it('rejects a deliberate restoration of historical row invalidation', async () => {
  const { failed, receipt } = await measure('chromium', true);
  expect(failed).toBe(true);
  expect(receipt.passed).toBe(false);
  expect(receipt.observations.every((value: { closedRowRenders: number }) => value.closedRowRenders > 0)).toBe(true);
}, 120000);
it('reports benchmark stderr when a missing browser prevents a receipt', async () => {
  await expect(measure('webkit', false, {
    name: 'webkit-missing-browser',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(directory, 'missing-browsers') },
  })).rejects.toThrow(/did not produce a readable receipt[\s\S]*Executable doesn't exist/);
}, 120000);


it('keeps long-history selection, draft, keyboard navigation and fixture streams correct in Chromium', async () => {
  await mkdir(directory, { recursive: true });
  const output = join(directory, 'long-history.json');
  await promisify(execFile)(process.execPath, ['scripts/bench/interactions/transcript-tab-reuse.mjs',
    '--long-history', '--samples=1', `--output=${output}`,
  ], { timeout: 240000 });
  const receipt = JSON.parse(await readFile(output, 'utf8'));
  expect(receipt.errors).toEqual([]);
  expect(receipt.correct).toBe(true);
  expect(receipt.falsification.budgetFailed).toBe(true);
  expect(receipt.observations[0].control.injectedDelayApplications).toBe(1);
  expect(receipt.fixture.map((fixture: { payloadBytes: number }) => fixture.payloadBytes)).toEqual([1704281, 1704281]);
  expect(receipt.observations[0]).toMatchObject({ scrollRestored: true, selectionCopied: true,
    keyboardSelection: true, streamTailCorrect: true, copyCorrect: true, jumpCorrect: true, mountedMessages: 10000 });
}, 300000);
