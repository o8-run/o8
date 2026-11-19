// Generate expectations with the real TS normalization and retention owners.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function main() {
  const root = mkdtempSync(join(tmpdir(), 'o8-composer-vectors-'));
  process.env.O8_DATA_DIR = root;
  process.env.CORTEX_IDE_DATA_DIR = root;
  process.env.CORTEX_IDE_MEDIA_ROOT = join(root, 'media');
  try {
    const { validateComposerQueuePayload } = await import('../../src/lib/orchestrator/composer-queue');
    const { composerPayloadHash, compactComposerPayload } = await import('../../src/lib/orchestrator/composer-queue-ledger');
    const routing = { backend: 'codex', model: 'fixture-model', effort: 'low', permissionMode: 'full', mode: 'single', pickedMode: 'fast', collide: false };
    const inputs: Array<Record<string, unknown>> = [
      { text: 'fixture', wireMessage: 'fixture', images: [], routing },
      { text: '雪 𝒳\nfixture', wireMessage: 'wire\tfixture', images: [], routing: { ...routing, projectId: 'fixture-project', serviceTier: 'fast' } },
      { text: 'follow up', wireMessage: 'follow up', afterTaskId: 'fixture-task', images: [], routing: { ...routing, pinBackend: true } },
      { text: 'image fixture', wireMessage: 'image fixture', images: [{ name: '雪 fixture', dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }], routing },
      { text: 'recorded selection', wireMessage: 'recorded selection', images: [], routing, wsSelection: { backend: 'codex', model: 'fixture-model', thinkingEffort: 'low', permissionMode: 'full', orchestrationMode: 'fast', pickedMode: 'fast', serviceTier: 'default', projectId: 'fixture-project', handoffMode: 'handoff', pinBackend: true, collideBaseBackend: 'codex' } },
    ];
    const vectors = inputs.map(input => {
      const normalized = validateComposerQueuePayload(input);
      const serialized = JSON.stringify({ ...normalized, ...(input.wsSelection ? { wsSelection: input.wsSelection } : {}) });
      const actualSteer = compactComposerPayload(serialized, true);
      const media = JSON.parse(actualSteer).deliveredMedia as Array<{ path: string }> | undefined;
      const mediaFiles = (media ?? []).map(file => ({ path: file.path.replaceAll(root, '<fixture-root>'), base64: readFileSync(file.path).toString('base64') }));
      const compactSteer = actualSteer.replaceAll(root, '<fixture-root>');
      return { serialized, hash: composerPayloadHash(serialized), bytes: Buffer.byteLength(serialized),
        compactNext: compactComposerPayload(serialized), compactSteer, mediaFiles,
        mediaJson: JSON.parse(compactSteer).deliveredMedia ? JSON.stringify(JSON.parse(compactSteer).deliveredMedia) : null };
    });
    writeFileSync(process.argv[2], JSON.stringify(vectors, null, 2) + '\n');
  } finally { rmSync(root, { recursive: true, force: true }); }

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
