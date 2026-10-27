(() => {
  if (window.__o8LaunchClientModules) return;
  const rows = new Map(), stack = [], wrapped = new WeakSet();
  window.__o8LaunchClientModules = rows;
  const callbacks = new Map(), callbackIds = new WeakMap();
  let nextCallbackId = 1;
  window.__o8LaunchFrameCallbacks = callbacks;
  const frame = window.requestAnimationFrame;
  window.requestAnimationFrame = function (callback) {
    if (!callbackIds.has(callback)) callbackIds.set(callback, nextCallbackId++);
    const id = callbackIds.get(callback);
    return frame.call(this, function (timestamp) {
      const start = performance.now();
      try { return callback.call(this, timestamp); }
      finally {
        if (callbacks.size < 64 || callbacks.has(id)) {
          const row = callbacks.get(id) || { id, name: callback.name || '<anonymous>', calls: 0, totalMs: 0, maxMs: 0 };
          const duration = performance.now() - start;
          row.calls++; row.totalMs += duration; row.maxMs = Math.max(row.maxMs, duration);
          callbacks.set(id, row);
        }
      }
    });
  };
  const canvas = {};
  window.__o8LaunchCanvas = canvas;
  if (typeof CanvasRenderingContext2D !== 'undefined') {
    for (const method of ['fillText', 'measureText', 'drawImage', 'clearRect']) {
      const original = CanvasRenderingContext2D.prototype[method];
      CanvasRenderingContext2D.prototype[method] = function (...args) {
        const start = performance.now();
        try { return original.apply(this, args); }
        finally {
          const row = canvas[method] ||= { calls: 0, totalMs: 0 };
          row.calls++; row.totalMs += performance.now() - start;
        }
      };
    }
  }
  const wrapChunk = chunk => {
    if (!chunk || !chunk[1] || typeof chunk[1] !== 'object') return;
    for (const [id, factory] of Object.entries(chunk[1])) {
      if (typeof factory !== 'function' || wrapped.has(factory)) continue;
      const observed = function (...args) {
        const frame = { start: performance.now(), children: 0 };
        stack.push(frame);
        try { return factory.apply(this, args); }
        finally {
          const duration = performance.now() - frame.start;
          stack.pop();
          if (stack.length) stack.at(-1).children += duration;
          if (rows.size < 4096 || rows.has(id)) {
            const row = rows.get(id) || { id, inclusiveMs: 0, exclusiveMs: 0, calls: 0 };
            row.inclusiveMs += duration;
            row.exclusiveMs += duration - frame.children;
            row.calls++;
            rows.set(id, row);
          }
        }
      };
      wrapped.add(observed);
      chunk[1][id] = observed;
    }
  };
  const chunks = window.webpackChunk_N_E || [];
  chunks.forEach(wrapChunk);
  const observePush = push => function (...args) {
    args.forEach(wrapChunk);
    return push.apply(this, args);
  };
  let push = observePush(chunks.push);
  Object.defineProperty(chunks, 'push', {
    configurable: true, get: () => push, set: value => { push = observePush(value); },
  });
  window.webpackChunk_N_E = chunks;
})();
