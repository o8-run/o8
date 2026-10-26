export function runRegisteredBuild(
  run: import('../../src/lib/workspace/generated-output-producer').GeneratedOutputSpawn,
  options?: { restoredCache?: boolean },
): Promise<number>;
