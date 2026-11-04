// The median measured file takes 6s. Assume a new unknown file is slow
// rather than fast until it has a measurement.
const DEFAULT_WEIGHT_SECONDS = 60;

export function splitIntegrationFiles(files, weights, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('integration shard count must be a positive integer');
  const shards = Array.from({ length: count }, () => ({ files: [], totalSeconds: 0 }));
  const weightFor = file => weights[file] ?? DEFAULT_WEIGHT_SECONDS;
  const longestFirst = [...files].sort((a, b) => weightFor(b) - weightFor(a) || (a < b ? -1 : a > b ? 1 : 0));
  const owners = new Map();
  for (const file of longestFirst) {
    // Equal totals go to the first shard, making the assignment deterministic.
    let owner = 0;
    for (let index = 1; index < count; index++) {
      if (shards[index].totalSeconds < shards[owner].totalSeconds) owner = index;
    }
    owners.set(file, owner);
    shards[owner].totalSeconds += weightFor(file);
  }
  // Execution and logs retain manifest order, independent of packing order.
  for (const file of files) shards[owners.get(file)].files.push(file);
  return shards;
}
