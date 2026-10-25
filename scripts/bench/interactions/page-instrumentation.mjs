// In-page instrumentation for the interaction harness. Everything here is
// serialized into the browser, so it must stay dependency-free.

// Installed with page.addInitScript before any app code runs.
export function instrumentationInitScript({ injectedDelayMs = 0, selectedRepoId = null } = {}) {
  // The dashboard persists its selected repository in sessionStorage while
  // tab state lives in the isolated fixture data directory. Seed both halves
  // of the same workspace so the app does not legitimately rebind tile-root
  // to a different fleet repo before restoring the fixture tabs.
  if (typeof selectedRepoId === 'string' && selectedRepoId) {
    sessionStorage.setItem('cortex-global-repo-id', selectedRepoId);
  }
  const state = {
    startedAt: performance.now(),
    longTasks: [],
    eventTimings: [],
    supported: { longtask: false, event: false, paint: false },
    hydratedAtMs: null,
    activeWorkspaceId: null,
    activeTabId: null,
    activeLabel: null,
    activeWorkspaceTabIds: [],
    workspaceEvents: [],
    injectedDelayMs,
    injectedDelayApplications: 0,
  };
  globalThis.__o8Interactions = state;

  const supportedTypes = PerformanceObserver.supportedEntryTypes ?? [];
  state.supported.longtask = supportedTypes.includes('longtask');
  state.supported.event = supportedTypes.includes('event');
  state.supported.paint = supportedTypes.includes('paint');

  if (state.supported.longtask) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  }
  if (state.supported.event) {
    // durationThreshold is clamped to 16ms by the spec, so a sub-frame input
    // produces no entry at all. The runner falls back to its own timing then.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.eventTimings.push({
          name: entry.name,
          startTime: entry.startTime,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd,
          duration: entry.duration,
        });
        if (state.eventTimings.length > 2000) state.eventTimings.shift();
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  }

  // The dashboard sets data-o8-dashboard-hydrated on <html> once it has
  // hydrated. Stamping the time here, from a script installed before app code,
  // keeps the boundary off the runner's polling granularity.
  const stampHydration = () => {
    if (state.hydratedAtMs !== null) return true;
    if (document.documentElement?.getAttribute('data-o8-dashboard-hydrated') === '1') {
      state.hydratedAtMs = performance.now();
      return true;
    }
    return false;
  };
  // An init script runs before <html> exists, so documentElement can still be
  // null here. Waiting for it is the difference between measuring hydration and
  // silently never measuring it.
  const watchHydration = () => {
    if (!document.documentElement) { setTimeout(watchHydration, 0); return; }
    if (stampHydration()) return;
    const observer = new MutationObserver(() => { if (stampHydration()) observer.disconnect(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-o8-dashboard-hydrated'] });
  };
  watchHydration();

  // The workspace announces its active tab with this event, so a tab switch
  // has an app-authored completion signal instead of a style heuristic.
  window.addEventListener('o8:workspace-active-label', (event) => {
    const detail = event?.detail;
    const workspaceId = detail?.workspaceId;
    state.workspaceEvents.push({
      atMs: Number(performance.now().toFixed(2)),
      workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
      tabId: typeof detail?.tabId === 'string' ? detail.tabId : null,
      label: typeof detail?.label === 'string' ? detail.label : null,
      tabIds: Array.isArray(detail?.tabs)
        ? detail.tabs.map((tab) => tab?.id).filter((id) => typeof id === 'string')
        : [],
      activeWorkspaceSurface: detail?.activeWorkspaceSurface ?? null,
      removed: detail?.removed === true,
    });
    if (state.workspaceEvents.length > 100) state.workspaceEvents.shift();
    if (detail?.removed) {
      if (workspaceId && workspaceId === state.activeWorkspaceId) {
        state.activeWorkspaceId = null;
        state.activeTabId = null;
        state.activeLabel = null;
        state.activeWorkspaceTabIds = [];
      }
      return;
    }
    // Split and transitioning layouts can keep more than one workspace root
    // mounted. Inactive roots still broadcast their own tab state; accepting
    // whichever event happened last makes a real tab switch look stuck and
    // lets an inactive label satisfy active-context observation. Track only
    // the root the app marks as the active workspace surface. Older builds
    // that do not publish the field remain measurable.
    if (detail?.activeWorkspaceSurface === false) return;
    if (typeof workspaceId === 'string') state.activeWorkspaceId = workspaceId;
    const tabId = detail?.tabId;
    if (typeof tabId === 'string' || tabId === null) state.activeTabId = tabId;
    const label = detail?.label;
    if (typeof label === 'string' || label === null) state.activeLabel = label;
    state.activeWorkspaceTabIds = Array.isArray(detail?.tabs)
      ? detail.tabs.map((tab) => tab?.id).filter((id) => typeof id === 'string')
      : [];
  });

  if (injectedDelayMs > 0) {
    // The deliberate render delay. It blocks the main thread inside the
    // measured interaction exactly the way a real regression would.
    const block = () => {
      state.injectedDelayApplications += 1;
      const until = performance.now() + injectedDelayMs;
      while (performance.now() < until) { /* deliberate main-thread stall */ }
    };
    window.addEventListener('keydown', block, true);
    window.addEventListener('pointerdown', block, true);
  }
}

// NOTE: page.evaluate serializes only the function it is handed, so every
// helper an evaluated function needs must live inside that function. This
// split is declared inline in each observer below rather than shared here.

// Runs inside the page. The caller starts this evaluate, then dispatches a
// trusted key press through the browser protocol, then awaits the result: a
// script-synthesized event would not exercise the real input path.
export async function observeComposerKeystroke(input) {
  const selector = typeof input === 'string' ? input : input.selector;
  // Inlined because page.evaluate cannot see module scope.
  const phaseSplit = (entry, fallback) => ({
    serverWaitMs: { value: null, note: 'no network request participates in this input path' },
    inputDelayMs: entry
      ? { value: Number((entry.processingStart - entry.startTime).toFixed(2)) }
      : fallback.inputDelayMs,
    mainThreadMs: entry
      ? { value: Number((entry.processingEnd - entry.processingStart).toFixed(2)) }
      : fallback.mainThreadMs,
    reactCommitMs: { value: null, note: 'React commit is not separately exposed by the platform; it is inside mainThreadMs' },
    presentationMs: entry
      ? { value: Number((entry.startTime + entry.duration - entry.processingEnd).toFixed(2)) }
      : fallback.presentationMs,
  });
  const target = document.querySelector(selector);
  if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) {
    return { durationMs: null, note: `no editable composer matched ${selector}` };
  }
  const state = globalThis.__o8Interactions;
  const before = target.value;
  target.focus();
  if (document.activeElement !== target) return { durationMs: null, note: 'composer did not take focus' };

  const eventTimingsBefore = state?.eventTimings.length ?? 0;
  const observation = await new Promise((resolve) => {
    const started = performance.now();
    let keydownAt = null;
    let eventTimeStamp = null;
    let inputAt = null;
    const onKeydown = (event) => { keydownAt = performance.now(); eventTimeStamp = event.timeStamp; };
    const onInput = () => { inputAt = performance.now(); };
    target.addEventListener('keydown', onKeydown, true);
    target.addEventListener('input', onInput, true);
    if (typeof input === 'object' && input.readySignal) globalThis[input.readySignal] = true;
    const finish = (paintedAt, note) => {
      target.removeEventListener('keydown', onKeydown, true);
      target.removeEventListener('input', onInput, true);
      resolve({ started, keydownAt, eventTimeStamp, inputAt, paintedAt, note });
    };
    const deadline = started + 5000;
    const poll = () => {
      if (target.value !== before) {
        // rAF runs before paint, so the following frame is the first that can
        // observe the painted result.
        requestAnimationFrame(() => finish(performance.now(), null));
        return;
      }
      if (performance.now() > deadline) { finish(null, 'composer value never changed within 5000ms'); return; }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });

  const entry = (state?.eventTimings ?? []).slice(eventTimingsBefore)
    .find((candidate) => candidate.name === 'keydown') ?? null;
  const phases = phaseSplit(entry, {
    inputDelayMs: Number.isFinite(observation.keydownAt) && Number.isFinite(observation.eventTimeStamp)
      ? { value: Number(Math.max(0, observation.keydownAt - observation.eventTimeStamp).toFixed(2)) }
      : { value: null, note: 'input delay unavailable: no Event Timing entry and no keydown timestamp' },
    mainThreadMs: Number.isFinite(observation.inputAt) && Number.isFinite(observation.keydownAt)
      ? { value: Number(Math.max(0, observation.inputAt - observation.keydownAt).toFixed(2)) }
      : { value: null, note: 'main-thread handler time unavailable' },
    presentationMs: Number.isFinite(observation.paintedAt) && Number.isFinite(observation.inputAt)
      ? { value: Number(Math.max(0, observation.paintedAt - observation.inputAt).toFixed(2)) }
      : { value: null, note: 'presentation time unavailable' },
  });
  if (!Number.isFinite(observation.paintedAt)) {
    return { durationMs: null, note: observation.note ?? 'keystroke was never painted', phases };
  }
  const from = Number.isFinite(observation.eventTimeStamp) ? observation.eventTimeStamp : observation.keydownAt ?? observation.started;
  return {
    durationMs: Number((observation.paintedAt - from).toFixed(2)),
    phases,
    eventTimingUsed: Boolean(entry),
  };
}

// Runs inside the page. The caller starts this evaluate, then clicks the target
// tab through the browser protocol, then awaits the result.
export async function observeTabSwitch(targetTabId) {
  // Inlined because page.evaluate cannot see module scope.
  const phaseSplit = (entry, fallback) => ({
    serverWaitMs: { value: null, note: 'no network request participates in this input path' },
    inputDelayMs: entry
      ? { value: Number((entry.processingStart - entry.startTime).toFixed(2)) }
      : fallback.inputDelayMs,
    mainThreadMs: entry
      ? { value: Number((entry.processingEnd - entry.processingStart).toFixed(2)) }
      : fallback.mainThreadMs,
    reactCommitMs: { value: null, note: 'React commit is not separately exposed by the platform; it is inside mainThreadMs' },
    presentationMs: entry
      ? { value: Number((entry.startTime + entry.duration - entry.processingEnd).toFixed(2)) }
      : fallback.presentationMs,
  });
  const state = globalThis.__o8Interactions;
  const selector = `[data-o8-workspace-tab="${CSS.escape(targetTabId)}"]`;
  if (!document.querySelector(selector)) return { durationMs: null, note: `no workspace tab matched ${targetTabId}` };
  const previousTabId = state?.activeTabId ?? null;
  if (previousTabId === targetTabId) return { durationMs: null, note: `tab ${targetTabId} was already active` };
  const eventTimingsBefore = state?.eventTimings.length ?? 0;
  const observation = await new Promise((resolve) => {
    const started = performance.now();
    let pointerAt = null;
    let pointerTimeStamp = null;
    const onPointer = (event) => { pointerAt = performance.now(); pointerTimeStamp = event.timeStamp; };
    window.addEventListener('pointerdown', onPointer, true);
    const finish = (paintedAt, note) => {
      window.removeEventListener('pointerdown', onPointer, true);
      resolve({ started, pointerAt, pointerTimeStamp, paintedAt, note });
    };
    const deadline = started + 10_000;
    const poll = () => {
      // The workspace announces its active tab. Either the target becoming
      // active or the previous tab ceasing to be active is a real switch; the
      // second form covers surfaces that report a different id than the pill.
      const active = state?.activeTabId ?? null;
      if (active === targetTabId || (previousTabId !== null && active !== previousTabId)) {
        requestAnimationFrame(() => requestAnimationFrame(() => finish(performance.now(), null)));
        return;
      }
      if (performance.now() > deadline) {
        finish(null, `clicked tab pill ${targetTabId} but the workspace still reports ${active ?? 'no'} active tab after 10000ms`);
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
  const entry = (state?.eventTimings ?? []).slice(eventTimingsBefore)
    .find((candidate) => candidate.name === 'pointerdown' || candidate.name === 'click') ?? null;
  const phases = phaseSplit(entry, {
    inputDelayMs: Number.isFinite(observation.pointerAt) && Number.isFinite(observation.pointerTimeStamp)
      ? { value: Number(Math.max(0, observation.pointerAt - observation.pointerTimeStamp).toFixed(2)) }
      : { value: null, note: 'input delay unavailable: no Event Timing entry and no pointer timestamp' },
    mainThreadMs: { value: null, note: 'handler time unavailable without an Event Timing entry' },
    presentationMs: { value: null, note: 'presentation time unavailable without an Event Timing entry' },
  });
  if (!Number.isFinite(observation.paintedAt)) {
    return { durationMs: null, note: observation.note ?? 'tab never became active', phases };
  }
  const from = Number.isFinite(observation.pointerTimeStamp) ? observation.pointerTimeStamp : observation.pointerAt ?? observation.started;
  return { durationMs: Number((observation.paintedAt - from).toFixed(2)), phases, eventTimingUsed: Boolean(entry) };
}

// Runs inside the page: issues the fleet-inventory request the left panel waits
// on and splits it into server wait, transfer, and client parse.
export async function measureRepoInventory(input) {
  const timeoutMs = input?.timeoutMs ?? 10_000;
  const url = '/api/panel/repos';
  // The Resource Timing buffer fills during boot and silently drops later
  // entries, which is why the phase split for this request comes back empty
  // otherwise. Clearing it first guarantees our own entry has room.
  performance.clearResourceTimings();
  const startedAt = performance.now();
  let payloadText;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('inventory measurement timeout'), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return { durationMs: null, note: `${url} returned ${response.status}` };
    payloadText = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        durationMs: timeoutMs,
        censoredLowerBound: true,
        repoCount: null,
        note: `${url} exceeded the ${timeoutMs}ms measurement bound; recorded as a >=${timeoutMs}ms budget failure`,
        phases: {
          serverWaitMs: { value: timeoutMs, note: 'lower bound: request did not complete' },
          transferMs: { value: null, note: 'request did not complete' },
          mainThreadMs: { value: null, note: 'response was not available to parse' },
          reactCommitMs: { value: null, note: 'this probe measures the data path only; no React commit participates' },
          presentationMs: { value: null, note: 'this probe measures the data path only; nothing is painted' },
        },
      };
    }
    return { durationMs: null, note: `${url} failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timeout);
  }
  const receivedAt = performance.now();
  // The Resource Timing entry is queued after the response settles, so reading
  // it in the same task finds nothing and the phase split silently disappears.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const parseStart = performance.now();
  let repoCount = null;
  try {
    const payload = JSON.parse(payloadText);
    repoCount = Array.isArray(payload?.repos) ? payload.repos.length : null;
  } catch { repoCount = null; }
  const parseMs = performance.now() - parseStart;
  const entry = performance.getEntriesByType('resource')
    .filter((candidate) => candidate.name.includes(url) && candidate.startTime >= startedAt)
    .pop() ?? null;
  return {
    durationMs: Number((receivedAt - startedAt).toFixed(2)),
    repoCount,
    phases: {
      serverWaitMs: entry
        ? { value: Number((entry.responseStart - entry.requestStart).toFixed(2)) }
        : { value: null, note: 'Resource Timing entry unavailable for the inventory request' },
      transferMs: entry
        ? { value: Number((entry.responseEnd - entry.responseStart).toFixed(2)) }
        : { value: null, note: 'Resource Timing entry unavailable for the inventory request' },
      mainThreadMs: { value: Number(parseMs.toFixed(2)) },
      reactCommitMs: { value: null, note: 'this probe measures the data path only; no React commit participates' },
      presentationMs: { value: null, note: 'this probe measures the data path only; nothing is painted' },
    },
  };
}

// Runs inside the page after navigation: the boot phase split.
export function readBootPhases() {
  const state = globalThis.__o8Interactions;
  const navigation = performance.getEntriesByType('navigation')[0] ?? null;
  const paint = performance.getEntriesByName('first-contentful-paint')[0] ?? null;
  const hydratedAtMs = state?.hydratedAtMs ?? null;
  const longTasksBeforeReady = (state?.longTasks ?? [])
    .filter((task) => hydratedAtMs === null || task.startTime <= hydratedAtMs);
  return {
    hydratedAtMs,
    serverWaitMs: navigation ? Number((navigation.responseStart - navigation.requestStart).toFixed(2)) : null,
    mainThreadMs: state?.supported?.longtask
      ? Number(longTasksBeforeReady.reduce((total, task) => total + task.duration, 0).toFixed(2))
      : null,
    firstContentfulPaintMs: paint ? Number(paint.startTime.toFixed(2)) : null,
    longTaskSupported: state?.supported?.longtask ?? false,
    eventTimingSupported: state?.supported?.event ?? false,
  };
}

// Runs inside the page during the bounded soak window.
export function readSoakCounters(sinceMs) {
  const state = globalThis.__o8Interactions;
  const longTasks = (state?.longTasks ?? []).filter((task) => task.startTime >= sinceMs);
  return {
    longTaskCount: longTasks.length,
    longTaskMs: Number(longTasks.reduce((total, task) => total + task.duration, 0).toFixed(2)),
    longTaskSupported: state?.supported?.longtask ?? false,
    observedMs: Number((performance.now() - sinceMs).toFixed(2)),
  };
}

// Runs inside the page. The caller starts this evaluate, then clicks the
// Projects row through the browser protocol, then awaits the result. Measures
// the operator-visible fleet reveal: the moment the generated repositories are
// painted in the left panel, not the moment their data arrived.
export async function observeFleetReveal(input) {
  const { expectedCount, repoPattern, timeoutMs } = input;
  const state = globalThis.__o8Interactions;
  const panel = document.querySelector('[data-o8-agent-panel="true"]');
  if (!panel) return { durationMs: null, note: 'no [data-o8-agent-panel] to reveal into' };
  const pattern = new RegExp(repoPattern, 'g');
  const countRows = () => ((panel.innerText || '').match(pattern) ?? []).length;
  if (countRows() >= expectedCount) return { durationMs: null, note: 'fleet rows were already revealed before the interaction' };
  const eventTimingsBefore = state?.eventTimings.length ?? 0;
  const resourcesBefore = performance.getEntriesByType('resource').length;

  const observation = await new Promise((resolve) => {
    const started = performance.now();
    let pointerAt = null;
    let pointerTimeStamp = null;
    const onPointer = (event) => { pointerAt = performance.now(); pointerTimeStamp = event.timeStamp; };
    window.addEventListener('pointerdown', onPointer, true);
    const finish = (paintedAt, rows, note) => {
      window.removeEventListener('pointerdown', onPointer, true);
      resolve({ started, pointerAt, pointerTimeStamp, paintedAt, rows, note });
    };
    const deadline = started + timeoutMs;
    const poll = () => {
      const rows = countRows();
      if (rows >= expectedCount) {
        requestAnimationFrame(() => requestAnimationFrame(() => finish(performance.now(), rows, null)));
        return;
      }
      if (performance.now() > deadline) {
        finish(null, rows, `only ${rows}/${expectedCount} fleet rows painted within ${timeoutMs}ms`);
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });

  const entry = (state?.eventTimings ?? []).slice(eventTimingsBefore)
    .find((candidate) => candidate.name === 'pointerdown' || candidate.name === 'click') ?? null;
  // Resource entries are queued at responseEnd, so "newly appeared" also
  // catches requests that started long before the click. Attribute only the
  // ones that STARTED inside the measured window.
  const newResources = performance.getEntriesByType('resource').slice(resourcesBefore)
    .filter((candidate) => candidate.name.includes('/api/') && candidate.startTime >= observation.started);
  const serverWaitMs = newResources.length > 0
    ? Number(Math.max(...newResources.map((candidate) => candidate.responseStart - candidate.requestStart)).toFixed(2))
    : null;
  const longTaskMs = state?.supported?.longtask
    ? Number((state.longTasks
      .filter((task) => task.startTime >= observation.started)
      .reduce((total, task) => total + task.duration, 0)).toFixed(2))
    : null;
  const phases = {
    serverWaitMs: Number.isFinite(serverWaitMs)
      ? { value: serverWaitMs }
      : { value: null, note: 'the reveal issued no API request inside the measured window' },
    inputDelayMs: entry
      ? { value: Number((entry.processingStart - entry.startTime).toFixed(2)) }
      : Number.isFinite(observation.pointerAt) && Number.isFinite(observation.pointerTimeStamp)
        ? { value: Number(Math.max(0, observation.pointerAt - observation.pointerTimeStamp).toFixed(2)) }
        : { value: null, note: 'input delay unavailable: no Event Timing entry and no pointer timestamp' },
    mainThreadMs: Number.isFinite(longTaskMs)
      ? { value: longTaskMs }
      : { value: null, note: 'the browser does not expose longtask entries' },
    reactCommitMs: { value: null, note: 'React commit is not separately exposed by the platform; it is inside mainThreadMs' },
    presentationMs: entry
      ? { value: Number((entry.startTime + entry.duration - entry.processingEnd).toFixed(2)) }
      : { value: null, note: 'presentation time unavailable without an Event Timing entry' },
  };
  if (!Number.isFinite(observation.paintedAt)) {
    return { durationMs: null, note: observation.note, rows: observation.rows, phases };
  }
  const from = Number.isFinite(observation.pointerTimeStamp) ? observation.pointerTimeStamp : observation.pointerAt ?? observation.started;
  return {
    durationMs: Number((observation.paintedAt - from).toFixed(2)),
    rows: observation.rows,
    phases,
    eventTimingUsed: Boolean(entry),
  };
}

// Runs inside the page. The caller starts this evaluate, then clicks the target
// repository row, then awaits the result. Measures active-context reveal: the
// workspace actually re-anchoring on the selected repository.
export async function observeActiveContextReveal(input) {
  const { repoName, timeoutMs } = input;
  const state = globalThis.__o8Interactions;
  // Selecting a repository publishes an active-context chip labelled
  // "<repo> · <branch>". That label is authored by the app, so it is a real
  // rendered confirmation rather than a style heuristic. The row's own
  // "<repo> repository" label is excluded — it exists before the click.
  const anchored = () => Array.from(document.querySelectorAll('[aria-label],[title]'))
    .some((element) => {
      const label = element.getAttribute('aria-label') || element.getAttribute('title') || '';
      return label.startsWith(`${repoName} ·`) || label.startsWith(`${repoName}/`) || label.startsWith(`${repoName} /`);
    }) || [state?.activeLabel].some((label) => typeof label === 'string'
      && (label.startsWith(`${repoName} ·`) || label.startsWith(`${repoName}/`) || label.startsWith(`${repoName} /`)));
  if (anchored()) {
    return { durationMs: null, note: `workspace was already anchored on ${repoName}` };
  }
  const eventTimingsBefore = state?.eventTimings.length ?? 0;
  const observation = await new Promise((resolve) => {
    const started = performance.now();
    let pointerAt = null;
    let pointerTimeStamp = null;
    const onPointer = (event) => { pointerAt = performance.now(); pointerTimeStamp = event.timeStamp; };
    window.addEventListener('pointerdown', onPointer, true);
    const finish = (paintedAt, note) => {
      window.removeEventListener('pointerdown', onPointer, true);
      resolve({ started, pointerAt, pointerTimeStamp, paintedAt, note });
    };
    const deadline = started + timeoutMs;
    const poll = () => {
      if (anchored()) {
        requestAnimationFrame(() => requestAnimationFrame(() => finish(performance.now(), null)));
        return;
      }
      if (performance.now() > deadline) {
        finish(null, `no active-context label for ${repoName} appeared within ${timeoutMs}ms`);
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
  const entry = (state?.eventTimings ?? []).slice(eventTimingsBefore)
    .find((candidate) => candidate.name === 'pointerdown' || candidate.name === 'click') ?? null;
  const phases = {
    serverWaitMs: { value: null, note: 'context reveal is measured to paint; its requests are counted in the fleet reveal' },
    inputDelayMs: entry
      ? { value: Number((entry.processingStart - entry.startTime).toFixed(2)) }
      : { value: null, note: 'input delay unavailable without an Event Timing entry' },
    mainThreadMs: entry
      ? { value: Number((entry.processingEnd - entry.processingStart).toFixed(2)) }
      : { value: null, note: 'handler time unavailable without an Event Timing entry' },
    reactCommitMs: { value: null, note: 'React commit is not separately exposed by the platform; it is inside mainThreadMs' },
    presentationMs: entry
      ? { value: Number((entry.startTime + entry.duration - entry.processingEnd).toFixed(2)) }
      : { value: null, note: 'presentation time unavailable without an Event Timing entry' },
  };
  if (!Number.isFinite(observation.paintedAt)) return { durationMs: null, note: observation.note, phases };
  const from = Number.isFinite(observation.pointerTimeStamp) ? observation.pointerTimeStamp : observation.pointerAt ?? observation.started;
  return { durationMs: Number((observation.paintedAt - from).toFixed(2)), phases, eventTimingUsed: Boolean(entry) };
}

// Snapshot of the high-z overlay elements, used to detect the Design Mode hover
// label by DIFF rather than by guessing its selector: the label carries no data
// attribute, so "which element appeared when the pointer moved" is the only
// stable signal available without changing app code.
export function snapshotOverlayLabels() {
  return Array.from(document.querySelectorAll('div'))
    .filter((element) => {
      const style = getComputedStyle(element);
      return Number(style.zIndex) >= 9990 && style.pointerEvents === 'none' && (element.textContent || '').trim();
    })
    .map((element) => (element.textContent || '').trim());
}

// Runs inside the page: waits for a Design Mode hover label that was not
// present in `before`, then reports the frame it painted on.
export async function observeDesignHover(input) {
  const { before, timeoutMs } = input;
  const baseline = new Set(before);
  const started = performance.now();
  return new Promise((resolve) => {
    const deadline = started + timeoutMs;
    const poll = () => {
      const labels = Array.from(document.querySelectorAll('div'))
        .filter((element) => {
          const style = getComputedStyle(element);
          return Number(style.zIndex) >= 9990 && style.pointerEvents === 'none' && (element.textContent || '').trim();
        })
        .map((element) => (element.textContent || '').trim())
        .filter((text) => !baseline.has(text));
      if (labels.length > 0) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
          durationMs: Number((performance.now() - started).toFixed(2)),
          label: labels[0].slice(0, 60),
        })));
        return;
      }
      if (performance.now() > deadline) {
        const observed = Array.from(document.querySelectorAll('div'))
          .filter((element) => {
            const style = getComputedStyle(element);
            return Number(style.zIndex) >= 9990 && (element.textContent || '').trim();
          })
          .map((element) => `${getComputedStyle(element).pointerEvents}:${(element.textContent || '').trim().slice(0, 24)}`)
          .slice(0, 6);
        resolve({
          durationMs: null,
          note: `no new Design Mode hover label painted within ${timeoutMs}ms; overlay labels on screen: ${observed.length > 0 ? observed.join(' | ') : 'none'}`,
        });
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

// Runs inside the page: waits for a DOM predicate to hold and reports the frame
// it painted on. Gesture measurements start at the trusted input boundary,
// not observer installation or the time spent drawing before pointer release.
export async function observePaintedCondition(input) {
  const { selector, timeoutMs, requireFocusInside, triggerEvent, triggerSelector } = input;
  const started = performance.now();
  return new Promise((resolve) => {
    const deadline = started + timeoutMs;
    let triggerAt = triggerEvent ? null : started;
    let triggerTrusted = null;
    const onTrigger = (event) => {
      if (triggerAt !== null || !event.isTrusted) return;
      if (triggerSelector && (!(event.target instanceof Element) || !event.target.closest(triggerSelector))) return;
      triggerAt = event.timeStamp;
      triggerTrusted = event.isTrusted;
    };
    if (triggerEvent) window.addEventListener(triggerEvent, onTrigger, true);
    const finish = (paintedAt, note = null) => {
      if (triggerEvent) window.removeEventListener(triggerEvent, onTrigger, true);
      resolve({
        durationMs: paintedAt !== null && triggerAt !== null
          ? Number((paintedAt - triggerAt).toFixed(2)) : null,
        observerStartedAt: started,
        triggerAt,
        triggerTrusted,
        paintedAt,
        triggerEvent: triggerEvent ?? null,
        note,
      });
    };
    const poll = () => {
      const element = document.querySelector(selector);
      const focusOk = !requireFocusInside || (element ? element.contains(document.activeElement) : false);
      if (triggerAt !== null && element && focusOk) {
        requestAnimationFrame(() => requestAnimationFrame(() => finish(performance.now())));
        return;
      }
      if (performance.now() > deadline) {
        finish(null, triggerAt === null
          ? `no trusted ${triggerEvent} on ${triggerSelector ?? 'window'} within ${timeoutMs}ms`
          : requireFocusInside
            ? `${selector} never took focus within ${timeoutMs}ms`
            : `${selector} never painted within ${timeoutMs}ms`);
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}
