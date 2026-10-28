// Offline dominators over strong snapshot edges. Never publish raw string contents.
import fs from 'node:fs';

export function retainedOwners(file) {
  const heap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { node_fields: nf, edge_fields: ef, node_types: nt, edge_types: et } = heap.snapshot.meta;
  const nw = nf.length, ew = ef.length, count = heap.nodes.length / nw;
  const ni = Object.fromEntries(nf.map((name, i) => [name, i]));
  const ei = Object.fromEntries(ef.map((name, i) => [name, i]));
  const weak = et[ei.type].indexOf('weak');
  const offsets = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + heap.nodes[i * nw + ni.edge_count] * ew;
  const seen = new Uint8Array(count);
  const stack = [0], cursors = [offsets[0]], postorder = [];
  seen[0] = 1;
  while (stack.length) {
    const top = stack.length - 1, source = stack[top], edge = cursors[top];
    if (edge === offsets[source + 1]) { postorder.push(source); stack.pop(); cursors.pop(); continue; }
    cursors[top] += ew;
    if (heap.edges[edge + ei.type] === weak) continue;
    const target = heap.edges[edge + ei.to_node] / nw;
    if (!seen[target]) { seen[target] = 1; stack.push(target); cursors.push(offsets[target]); }
  }
  const order = postorder.reverse();
  const rank = new Int32Array(count).fill(-1);
  order.forEach((node, index) => { rank[node] = index; });
  const incoming = new Uint32Array(count + 1);
  for (const source of order) {
    for (let edge = offsets[source]; edge < offsets[source + 1]; edge += ew) {
      if (heap.edges[edge + ei.type] !== weak) incoming[heap.edges[edge + ei.to_node] / nw + 1]++;
    }
  }
  for (let i = 1; i <= count; i++) incoming[i] += incoming[i - 1];
  const predecessors = new Uint32Array(incoming[count]);
  const cursor = incoming.slice();
  for (const source of order) {
    for (let edge = offsets[source]; edge < offsets[source + 1]; edge += ew) {
      if (heap.edges[edge + ei.type] === weak) continue;
      const target = heap.edges[edge + ei.to_node] / nw;
      predecessors[cursor[target]++] = source;
    }
  }
  const dominator = new Int32Array(count).fill(-1);
  dominator[0] = 0;
  function intersect(left, right) {
    while (left !== right) {
      while (rank[left] > rank[right]) left = dominator[left];
      while (rank[right] > rank[left]) right = dominator[right];
    }
    return left;
  }
  let changed = true, passes = 0;
  while (changed) {
    changed = false; passes++;
    for (let i = 1; i < order.length; i++) {
      const node = order[i];
      let parent = -1;
      for (let index = incoming[node]; index < incoming[node + 1]; index++) {
        const previous = predecessors[index];
        if (dominator[previous] === -1) continue;
        parent = parent === -1 ? previous : intersect(parent, previous);
      }
      if (parent !== dominator[node]) { dominator[node] = parent; changed = true; }
    }
  }
  const retained = new Float64Array(count);
  for (const node of order) retained[node] = heap.nodes[node * nw + ni.self_size];
  for (let i = order.length - 1; i > 0; i--) retained[dominator[order[i]]] += retained[order[i]];
  function label(node) {
    const type = nt[ni.type][heap.nodes[node * nw + ni.type]];
    const raw = heap.strings[heap.nodes[node * nw + ni.name]];
    const script = raw.match(/(?:^|[\\/])\.next[\\/]server[\\/](?:app|chunks)[\\/]([\w/.-]+\.js)$/);
    const dependency = raw.match(/(?:^|[\\/])node_modules[\\/]([@\w/.-]+\.[cm]?js)$/);
    const name = type.includes('string') ? type : script ? `.next/server/${script[0].split('server/').pop()}`
      : dependency ? `node_modules/${dependency[1]}`
      : /^node:[\w/.-]+$/.test(raw) ? raw
      : /^[A-Za-z_$([\]][\w$ ()[\].-]{0,80}$/.test(raw) ? raw : type;
    return { type, name };
  }
  const candidates = order.filter(node => node !== 0 && label(node).type !== 'synthetic')
    .sort((a, b) => retained[b] - retained[a]);
  const owners = candidates.slice(0, 20).map(node => {
    const ancestry = [];
    let parent = dominator[node];
    while (parent > 0 && ancestry.length < 12) { ancestry.push(label(parent)); parent = dominator[parent]; }
    return { ...label(node), retainedBytes: retained[node], shallowBytes: heap.nodes[node * nw + ni.self_size], dominators: ancestry.reverse() };
  });
  const requestObjects = { Request: 0, NextRequest: 0, Response: 0, NextResponse: 0 };
  const runArtifactCaches = { parsedEntries: { count: 0, retainedBytes: 0 }, serialized: { count: 0, retainedBytes: 0 },
    serializedEntries: { count: 0, retainedBytes: 0 } };
  for (const node of order) {
    const { type, name } = label(node);
    if (type === 'object' && Object.hasOwn(requestObjects, name)) requestObjects[name]++;
    if (type !== 'object') continue;
    const properties = new Set();
    for (let edge = offsets[node]; edge < offsets[node + 1]; edge += ew) {
      if (et[ei.type][heap.edges[edge + ei.type]] === 'property') properties.add(heap.strings[heap.edges[edge + ei.name_or_index]]);
    }
    const serialized = name === 'RunArtifactCache'
      || ['entries', 'bytes', 'maxBytes', 'maxEntries', 'ttlMs'].every(key => properties.has(key));
    const bucket = serialized ? runArtifactCaches.serialized
      : ['payload', 'bytes', 'expiresAt'].every(key => properties.has(key)) ? runArtifactCaches.serializedEntries
      : ['key', 'parsed', 'stdoutRaw', 'stderrRaw'].every(key => properties.has(key)) ? runArtifactCaches.parsedEntries : null;
    if (bucket) { bucket.count++; bucket.retainedBytes += retained[node]; }
  }
  return { method: 'Immediate dominators over reachable non-weak snapshot edges', passes, reachableNodes: order.length,
    requestObjects, runArtifactCaches, owners };
}
