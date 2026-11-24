type BrowserAgentVerb = 'read' | 'localize' | 'rect' | 'click' | 'type' | 'probe' | 'grab';

/**
 * Eval snippet calling one in-page browser-agent verb and RETURNING the result
 * OBJECT (not JSON-stringified). The native browser-view tier evals this via
 * `browser_view_eval_result`, which NSJSON-encodes the WKWebView return value — so
 * the verb returns a plain object and the host pulls the JSON back. This replaces
 * the in-page `fetch` POST channel, which HTTPS pages mixed-content block.
 */
export function nativeReturnEval(verb: BrowserAgentVerb, args: Record<string, unknown>): string {
  return `(function(){
    var a = window.__o8BrowserAgent;
    if (!a) return { ok: false, error: 'native browser agent not installed yet' };
    try { return a.${verb}(${JSON.stringify(args)}); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  })()`;
}

/** Eval snippet calling one in-page browser-agent verb; returns a JSON string. */
export function browserAgentEval(verb: BrowserAgentVerb, args: Record<string, unknown>): string {
  return `(() => {
    const agent = window.__o8BrowserAgent;
    if (!agent) return JSON.stringify({ ok: false, error: 'browser agent not installed — open a browser card (canvas) or the Browser tab first' });
    try { return JSON.stringify(agent.${verb}(${JSON.stringify(args)})); }
    catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); }
  })()`;
}
