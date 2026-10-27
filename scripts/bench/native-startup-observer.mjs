// Injected into disposable build copies before any dashboard client code runs.
export const NATIVE_STARTUP_OBSERVER_JS = `(() => {
  if (window.__o8StartupObserverVersion === 1) return;
  window.__o8OptionalStartupRequests = 0;
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const input = args[0];
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === '/api/automations/connected') window.__o8OptionalStartupRequests++;
    } catch {}
    return originalFetch.apply(this, args);
  };
  window.__o8StartupObserverVersion = 1;
  window.__o8StartupFetchObserved = true;
})();`;
