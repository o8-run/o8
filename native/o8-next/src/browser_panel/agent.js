(function () {
  if (typeof window === 'undefined' || window.__o8BrowserAgent) return;
  try {
    function hideScrollbarChrome() {
      if (!document.documentElement || document.getElementById("o8-native-scrollbars")) return;
      var style = document.createElement("style");
      style.id = "o8-native-scrollbars";
      style.textContent = "* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }";
      document.documentElement.appendChild(style);
    }
    hideScrollbarChrome();
    document.addEventListener("DOMContentLoaded", hideScrollbarChrome, { once: true });
  } catch (_) {}

  // ── no-drift shared algorithms ──
const selectorFor = function selectorFor(el) {
  const doc = el.ownerDocument;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let node = el;
  for (let depth = 0; node && node !== doc.documentElement && depth < 5; depth++) {
    let part = node.tagName.toLowerCase();
    const classes = [...node.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
    if (classes) part += classes;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    try {
      if (doc.querySelectorAll(parts.join(" > ")).length === 1) return parts.join(" > ");
    } catch {
    }
    node = parent;
  }
  return parts.join(" > ");
};
const buildGrabbedElement = function buildGrabbedElement(el, cssSelector) {
  const win = el.ownerDocument.defaultView || window;
  const computed = win.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const styleKeys = [
    "color",
    "backgroundColor",
    "fontSize",
    "fontFamily",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textAlign",
    "padding",
    "margin",
    "border",
    "borderRadius",
    "boxShadow",
    "display",
    "position",
    "width",
    "height",
    "gap",
    "flexDirection",
    "alignItems",
    "justifyContent",
    "opacity",
    "zIndex"
  ];
  const computedStyles = {};
  for (const key of styleKeys) {
    const value = computed[key];
    if (value != null && value !== "") computedStyles[key] = String(value);
  }
  const trim = (value, max) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max) : text;
  };
  const describe = (node) => {
    let out = node.tagName.toLowerCase();
    if (node.id) out += `#${node.id}`;
    const classes = Array.from(node.classList).slice(0, 2);
    if (classes.length) out += `.${classes.join(".")}`;
    return out;
  };
  const roleFor = (node) => {
    const explicit = node.getAttribute("role");
    if (explicit) return explicit;
    const tag = node.tagName.toLowerCase();
    if (tag === "a" && node.getAttribute("href")) return "link";
    if (tag === "input") {
      const type = (node.getAttribute("type") || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    const roles = {
      aside: "complementary",
      button: "button",
      footer: "contentinfo",
      form: "form",
      header: "banner",
      img: "img",
      li: "listitem",
      main: "main",
      nav: "navigation",
      ol: "list",
      select: "combobox",
      table: "table",
      textarea: "textbox",
      ul: "list"
    };
    return roles[tag] || "";
  };
  const attributes = {};
  const ariaAttributes = {};
  for (const attr of Array.from(el.attributes)) {
    const name2 = attr.name;
    if (name2.startsWith("aria-")) ariaAttributes[name2] = attr.value;
    if (name2 === "role" || name2 === "href" || name2 === "src" || name2 === "alt" || name2 === "title" || name2 === "type" || name2.startsWith("data-") || name2.startsWith("aria-")) {
      attributes[name2] = attr.value;
    }
  }
  const accessibleName = () => {
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || "").join(" ").replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 120);
    }
    const candidates = [el.getAttribute("aria-label"), el.getAttribute("alt"), el.getAttribute("title"), el.textContent];
    for (const candidate of candidates) {
      const text = (candidate || "").replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 120);
    }
    return "";
  };
  const parentChain = [];
  let parent = el.parentElement;
  while (parent) {
    parentChain.unshift(describe(parent));
    if (parent === el.ownerDocument.body) break;
    parent = parent.parentElement;
  }
  const ancestorChain = [];
  let ancestor = el.parentElement;
  while (ancestor && ancestorChain.length < 4) {
    ancestorChain.unshift(describe(ancestor));
    ancestor = ancestor.parentElement;
  }
  const landmarkRoles = /* @__PURE__ */ new Set(["banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search"]);
  let landmark = el;
  let nearestLandmark = "";
  while (landmark) {
    if (landmarkRoles.has(roleFor(landmark))) {
      nearestLandmark = describe(landmark);
      break;
    }
    landmark = landmark.parentElement;
  }
  const role = roleFor(el);
  const name = accessibleName();
  const boundingRect = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || "",
    classList: Array.from(el.classList),
    textContent: trim(el.textContent || "", 200),
    attributes,
    boundingRect,
    cssSelector,
    computedStyles,
    accessibility: { role, name, ariaAttributes },
    innerHTML: trim(el.innerHTML || "", 500),
    outerHTML: trim(el.outerHTML || "", 600),
    parentChain,
    domSummary: { role, accessibleName: name, ancestorChain, boundingRect, nearestLandmark }
  };
};
var reactComponentName = function reactComponentName(el) {
  try {
    let node = el;
    for (let up = 0; node && up < 12; up++) {
      let fiber = null;
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.lastIndexOf("__reactFiber$", 0) === 0 || k.lastIndexOf("__reactInternalInstance$", 0) === 0) {
          fiber = node[k];
          break;
        }
      }
      if (fiber) {
        let f = fiber;
        for (let depth = 0; f && depth < 40; depth++) {
          const t = f.type;
          if (t && typeof t !== "string") {
            const to = t;
            const render = to.render;
            const inner = to.type;
            const name = to.displayName || to.name || (render ? render.displayName || render.name : "") || (inner ? inner.displayName || inner.name : "");
            if (name && typeof name === "string" && name.length > 1 && name.charAt(0) === name.charAt(0).toUpperCase() && name.charAt(0) !== name.charAt(0).toLowerCase()) {
              return name;
            }
          }
          f = f.return || null;
        }
      }
      node = node.parentElement;
    }
  } catch {
  }
  return null;
};
const collectBrowserLocalizationRows = function collectBrowserLocalizationRows(root, selectorForElement, labelForElement, limit = 80) {
  const doc = root.ownerDocument ?? root;
  const view = doc.defaultView;
  const viewportWidth = view?.innerWidth ?? Number.POSITIVE_INFINITY;
  const viewportHeight = view?.innerHeight ?? Number.POSITIVE_INFINITY;
  const query = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    "[onclick]"
  ].join(",");
  const rows = [];
  for (const element of root.querySelectorAll(query)) {
    if (rows.length >= limit) break;
    if (element.getAttribute("aria-hidden") === "true") continue;
    const style = view?.getComputedStyle?.(element);
    if (style && (style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0")) continue;
    const raw = element.getBoundingClientRect();
    const left = Math.max(0, raw.left);
    const top = Math.max(0, raw.top);
    const right = Math.min(viewportWidth, raw.right);
    const bottom = Math.min(viewportHeight, raw.bottom);
    if (right - left < 4 || bottom - top < 4) continue;
    rows.push({
      selector: selectorForElement(element),
      tag: element.tagName.toLowerCase(),
      label: labelForElement(element),
      rect: { left, top, width: right - left, height: bottom - top }
    });
  }
  return rows;
};

  // ── helpers ──
  function labelFor(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return aria;
    var value = el.placeholder || '';
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    return (text || value || el.getAttribute('title') || '').slice(0, 80);
  }

  // ── ghost cursor (the spectator layer — one per page, reused) ──
  var cursorState = null;
  function ensureCursor() {
    if (cursorState && document.body && document.body.contains(cursorState.cursor)) return cursorState;
    if (!document.body) return null;
    var cursor = document.createElement('div');
    cursor.setAttribute('data-o8-agent-cursor', 'true');
    cursor.setAttribute('style', [
      'position:fixed;left:0;top:0;width:16px;height:16px;border-radius:50%',
      'background:rgba(245,158,11,0.9);border:2px solid rgba(255,255,255,0.95)',
      'box-shadow:0 0 0 4px rgba(245,158,11,0.22), 0 2px 10px rgba(0,0,0,0.4)',
      'z-index:2147483600;pointer-events:none;opacity:0;transform:translate(-50%,-50%)',
      'transition:left 320ms cubic-bezier(0.22,1,0.36,1),top 320ms cubic-bezier(0.22,1,0.36,1),opacity 220ms ease-out',
    ].join(';'));
    var ripple = document.createElement('div');
    ripple.setAttribute('data-o8-agent-cursor-ripple', 'true');
    ripple.setAttribute('style', [
      'position:fixed;left:0;top:0;width:16px;height:16px;border-radius:50%',
      'border:2px solid rgba(245,158,11,0.7)',
      'z-index:2147483599;pointer-events:none;opacity:0;transform:translate(-50%,-50%)',
    ].join(';'));
    document.body.appendChild(cursor);
    document.body.appendChild(ripple);
    cursorState = { cursor: cursor, ripple: ripple, hideTimer: null };
    return cursorState;
  }
  function paintCursor(x, y) {
    try {
      var state = ensureCursor();
      if (!state) return;
      var left = Math.round(x) + 'px';
      var top = Math.round(y) + 'px';
      state.cursor.style.opacity = '1';
      state.cursor.style.left = left;
      state.cursor.style.top = top;
      state.ripple.style.left = left;
      state.ripple.style.top = top;
      if (typeof state.ripple.animate === 'function') {
        state.ripple.animate(
          [{ transform: 'translate(-50%,-50%) scale(0.7)', opacity: 0.8 }, { transform: 'translate(-50%,-50%) scale(3.2)', opacity: 0 }],
          { duration: 520, easing: 'ease-out' },
        );
      }
      if (state.hideTimer) clearTimeout(state.hideTimer);
      state.hideTimer = setTimeout(function () { state.cursor.style.opacity = '0'; }, 2400);
    } catch (e) { /* theater is best-effort */ }
  }

  // ── verbs (operate on this page document directly) ──
  function read(args) {
    args = args || {};
    var root = args.selector ? (document.querySelector(args.selector) || document.body) : document.body;
    if (!root) return { ok: false, error: 'page has no body yet' };
    var maxChars = Math.min(14000, Math.max(400, args.maxChars || 6000));
    var text = (root.innerText || root.textContent || '').replace(/\n{3,}/g, '\n\n');
    var interactive = [];
    var nodes = root.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [onclick]');
    for (var i = 0; i < nodes.length; i++) {
      if (interactive.length >= 60) break;
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      interactive.push({ selector: selectorFor(el), tag: el.tagName.toLowerCase(), label: labelFor(el) });
    }
    return {
      ok: true,
      url: location.href,
      title: document.title,
      text: text.length > maxChars ? text.slice(0, maxChars) + '\u2026 [truncated ' + (text.length - maxChars) + ' chars]' : text,
      interactive: interactive,
    };
  }

  function localize() {
    if (!document.body) return { ok: false, error: 'page has no body yet' };
    return { ok: true, url: location.href, surface: "native", coordinateSpace: "page-viewport", viewport: { width: innerWidth, height: innerHeight }, interactive: collectBrowserLocalizationRows(document.body, selectorFor, labelFor) };
  }
  function rect(args) {
    args = args || {}; var el = args.selector ? document.querySelector(args.selector) : null;
    if (!el) return { ok: false, error: 'no element matches ' + args.selector };
    var rows = collectBrowserLocalizationRows({ ownerDocument: document, querySelectorAll: function () { return [el]; } }, selectorFor, labelFor, 1);
    if (!rows.length) return { ok: false, error: 'element is not visibly actionable: ' + args.selector };
    var row = rows[0]; row.ok = true; row.surface = "native"; row.coordinateSpace = "page-viewport"; row.viewport = { width: innerWidth, height: innerHeight }; return row;
  }

  function click(args) {
    args = args || {};
    var el = args.selector ? document.querySelector(args.selector) : null;
    if (!el) return { ok: false, error: 'no element matches ' + args.selector };
    var rect = el.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    paintCursor(x, y);
    var opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    if (typeof el.click === 'function') el.click();
    return { ok: true, clicked: args.selector, label: labelFor(el) };
  }

  function type(args) {
    args = args || {};
    var el = args.selector ? document.querySelector(args.selector) : null;
    if (!el) return { ok: false, error: 'no element matches ' + args.selector };
    var rect = el.getBoundingClientRect();
    paintCursor(rect.left + Math.min(24, rect.width / 2), rect.top + rect.height / 2);
    el.focus();
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    var setter = desc && desc.set;
    if (setter) setter.call(el, args.text); else el.value = args.text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (args.submit) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      var form = el.closest('form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    }
    return { ok: true, typed: (args.text || '').length, into: args.selector };
  }

  function probe(args) {
    args = args || {};
    var el = args.selector ? document.querySelector(args.selector) : null;
    if (!el) return { ok: false, pending: true };
    if (args.text && (el.textContent || '').indexOf(args.text) === -1) return { ok: false, pending: true };
    return { ok: true, found: args.selector };
  }

  function grab(args) {
    args = args || {};
    var el = args.selector ? document.querySelector(args.selector) : null;
    if (!el) return { ok: false, error: 'no element matches ' + args.selector };
    var rect = el.getBoundingClientRect();
    paintCursor(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { ok: true, element: buildGrabbedElement(el, selectorFor(el)) };
  }

  // ── Design Mode freehand draw (native pages stay live) ──
  var __designDraw = null;
  function stopDesignDraw() { if (!__designDraw) return; var s = __designDraw; window.removeEventListener("keydown", s.key, true); s.canvas.remove(); s.hint.remove(); if (s.composer) s.composer.remove(); if (s.hover) s.hover.remove(); try { window.__o8DesignDrawPending = null; } catch (e) {} __designDraw = null; }
  function startDesignDraw(args) {
    if (!args || args.on !== true) { stopDesignDraw(); return { ok: true, armed: false }; } stopDesignDraw(); if (!document.body) return { ok: false, error: "page has no body yet" };
    var canvas = document.createElement("canvas"), hint = document.createElement("div"), hover = document.createElement("div"), ctx, points = [], drawing = false, composer = null;
    canvas.setAttribute("data-o8-design-draw", "true"); canvas.setAttribute("style", "position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483645;cursor:crosshair;touch-action:none;");
    hint.setAttribute("style", "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483646;padding:10px 14px;border:1px solid rgba(255,255,255,.12);border-radius:10px;background:#1c1c1e;color:#f5f5f7;font:600 12px -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:-.01em;pointer-events:none;"); hint.textContent = "Draw on the page · Esc to exit"; document.body.appendChild(canvas); document.body.appendChild(hint);
    try { if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setTimeout(function(){ hint.style.opacity = "0"; }, 4200); } else if (hint.animate) { hint.animate([{opacity:0,transform:"translateX(-50%) translateY(-3px)"},{opacity:1,transform:"translateX(-50%) translateY(0)"}], {duration:260,easing:"cubic-bezier(0.22,1,0.36,1)"}); hint.animate([{opacity:1},{opacity:0}], {duration:300,delay:4200,fill:"forwards"}); } } catch (e) {}
    // Pre-draw hover identity label (Cursor parity): a calm dark chip near
    // the cursor naming the React component + tag under it. Hidden while a
    // stroke is active or the composer is open; rAF-throttled.
    hover.setAttribute("data-o8-design-hover", "true"); hover.setAttribute("style", "position:fixed;left:0;top:0;z-index:2147483646;padding:3px 7px;border-radius:6px;background:rgba(28,28,30,0.92);color:#f5f5f7;font:600 10.5px -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:-.01em;pointer-events:none;opacity:0;transition:opacity 120ms ease;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 10px rgba(0,0,0,.35);"); document.body.appendChild(hover);
    var hoverRaf = false, hoverPt = null;
    function updateHover() { hoverRaf = false; if (!hoverPt || drawing || composer) { hover.style.opacity = "0"; return; } var px = hoverPt.x, py = hoverPt.y; canvas.style.pointerEvents = "none"; var el = document.elementFromPoint(px, py); canvas.style.pointerEvents = "auto"; if (!el || el === hover || el === canvas) { hover.style.opacity = "0"; return; } var comp = null; try { comp = reactComponentName(el); } catch (e) {} var tag = el.tagName ? el.tagName.toLowerCase() : ""; var txt = (comp ? comp + " \u00b7 " : "") + tag; if (!txt) { hover.style.opacity = "0"; return; } hover.textContent = txt; hover.style.left = Math.min(innerWidth - 8, px + 14) + "px"; hover.style.top = Math.min(innerHeight - 8, py + 16) + "px"; hover.style.opacity = "1"; }
    function scheduleHover(x, y) { hoverPt = { x: x, y: y }; if (hoverRaf) return; hoverRaf = true; (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(updateHover); }
    function size() { var d = window.devicePixelRatio || 1; canvas.width = innerWidth * d; canvas.height = innerHeight * d; ctx = canvas.getContext("2d"); ctx.scale(d, d); ctx.lineCap = "round"; ctx.lineJoin = "round"; } size();
    // Quadratic-smoothed dual-stroke ink (white halo under brand-orange) so
    // the drawing survives any page background, Apple Pencil style. Buffered
    // full-redraw on rAF — the raw incremental polyline read faceted.
    function trace() { if (points.length < 2) return; ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); if (points.length === 2) { ctx.lineTo(points[1].x, points[1].y); return; } for (var i = 1; i < points.length - 1; i++) { var mx = (points[i].x + points[i+1].x) / 2, my = (points[i].y + points[i+1].y) / 2; ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my); } ctx.lineTo(points[points.length-1].x, points[points.length-1].y); }
    function redraw() { ctx.clearRect(0, 0, innerWidth, innerHeight); if (points.length < 2) return; ctx.globalAlpha = 1; ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 5; trace(); ctx.stroke(); ctx.globalAlpha = 0.92; ctx.strokeStyle = "#FF5A1F"; ctx.lineWidth = 2.5; trace(); ctx.stroke(); ctx.globalAlpha = 1; }
    var rafPending = false; function scheduleRedraw() { if (rafPending) return; rafPending = true; (window.requestAnimationFrame || function(f){ setTimeout(f, 16); })(function(){ rafPending = false; redraw(); }); }
    function submit() { var input = composer && composer.querySelector("textarea"), text = input && input.value.trim(); if (!text || !points.length) return; var xs = points.map(function(p){return p.x;}), ys = points.map(function(p){return p.y;}), rect = { left: Math.min.apply(null,xs), top: Math.min.apply(null,ys), width: Math.max.apply(null,xs)-Math.min.apply(null,xs), height: Math.max.apply(null,ys)-Math.min.apply(null,ys) }, seen = {}, elements = []; canvas.style.pointerEvents = "none"; points.forEach(function(p) { if (elements.length >= 4) return; var el = document.elementFromPoint(p.x,p.y), key = el && selectorFor(el); if (el && key && !seen[key]) { seen[key] = true; var comp = null; try { comp = reactComponentName(el); } catch (e) {} elements.push({ selector:key, tag:el.tagName.toLowerCase(), text:(el.textContent||"").replace(/\s+/g," ").trim().slice(0,80), component: comp || null }); } }); canvas.style.pointerEvents = "auto"; window.__o8DesignDrawResult = { ok:true, text:text, rect:rect, points:points, elements:elements, viewport:{ width: innerWidth, height: innerHeight } }; }
    // Composer is built with createElement ONLY — hardened pages (o8.run)
    // enforce Trusted Types via CSP, and an innerHTML assignment THROWS
    // silently inside the pointerup handler (live-hit 2026-07-12: ink drew,
    // composer never appeared, mode stuck).
    function finish() { if (!drawing) return; drawing = false; if (points.length < 2) { points = []; redraw(); return; } var xs = points.map(function(p){return p.x;}), ys = points.map(function(p){return p.y;}), minX = Math.min.apply(null,xs), maxX = Math.max.apply(null,xs), minY = Math.min.apply(null,ys), maxY = Math.max.apply(null,ys); if (Math.max(maxX - minX, maxY - minY) < 6) { points = []; redraw(); return; } try { window.__o8DesignDrawPending = { rect: { left: minX, top: minY, width: maxX - minX, height: maxY - minY }, viewport: { width: innerWidth, height: innerHeight } }; } catch (e) {} var x = Math.min(innerWidth - 152, Math.max(152, (minX + maxX) / 2)), y = Math.min(innerHeight - 68, Math.max(12, maxY + 12)); composer = document.createElement("div"); composer.setAttribute("data-o8-design-composer", "true"); composer.setAttribute("style", "position:fixed;left:"+x+"px;top:"+y+"px;transform:translateX(-50%);z-index:2147483646;display:flex;gap:8px;padding:8px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:#1c1c1e;box-shadow:0 12px 32px rgba(0,0,0,.32);transition:box-shadow 130ms ease,border-color 130ms ease;"); var input = document.createElement("textarea"); input.rows = 1; input.placeholder = "Describe what to change here…"; input.setAttribute("style", "width:230px;resize:none;border:0;outline:0;background:transparent;color:#f5f5f7;font:13px -apple-system,BlinkMacSystemFont,sans-serif"); var button = document.createElement("button"); button.type = "button"; button.textContent = "Send"; button.setAttribute("style", "border:0;border-radius:8px;background:#FF5A1F;color:#fff;padding:0 11px;font:600 12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer"); function syncSend() { var empty = !input.value.trim(); button.disabled = empty; button.style.opacity = empty ? "0.45" : "1"; button.style.cursor = empty ? "default" : "pointer"; } var thumb = document.createElement("img"); thumb.setAttribute("data-o8-design-thumb", "true"); thumb.setAttribute("alt", ""); thumb.setAttribute("style", "height:44px;width:auto;max-width:120px;border-radius:6px;display:none;object-fit:cover;border:1px solid rgba(255,255,255,.14);flex-shrink:0;"); composer.appendChild(thumb); composer.appendChild(input); composer.appendChild(button); document.body.appendChild(composer); __designDraw.composer = composer; syncSend(); button.addEventListener("click", submit); input.addEventListener("input", syncSend); input.addEventListener("focus", function(){ composer.style.borderColor = "rgba(255,255,255,.3)"; composer.style.boxShadow = "0 12px 32px rgba(0,0,0,.32),0 0 0 2px rgba(255,90,31,.6)"; }); input.addEventListener("blur", function(){ composer.style.borderColor = "rgba(255,255,255,.12)"; composer.style.boxShadow = "0 12px 32px rgba(0,0,0,.32)"; }); input.addEventListener("keydown", function(e){ if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } e.stopPropagation(); }); try { if (composer.animate && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) { composer.animate([{opacity:0,transform:"translateX(-50%) translateY(4px) scale(0.96)"},{opacity:1,transform:"translateX(-50%) translateY(0) scale(1)"}], {duration:150,easing:"cubic-bezier(0.22,1,0.36,1)"}); } } catch (e) {} setTimeout(function(){ input.focus(); }, 30); }
    canvas.addEventListener("pointerdown", function(e){ if (e.button !== 0) return; if (composer) { composer.remove(); composer=null; __designDraw.composer=null; } try { window.__o8DesignDrawPending = null; } catch (e2) {} hover.style.opacity = "0"; drawing=true; points=[{x:e.clientX,y:e.clientY}]; canvas.setPointerCapture(e.pointerId); redraw(); e.preventDefault(); }); canvas.addEventListener("pointermove", function(e){ if (!drawing) { scheduleHover(e.clientX, e.clientY); return; } points.push({x:e.clientX,y:e.clientY}); scheduleRedraw(); e.preventDefault(); }); canvas.addEventListener("pointerup", function(e){ try { finish(); } catch (err) { window.__o8DesignDrawResult = { ok:false, error:"finish threw: " + String((err && err.message) || err) }; } e.preventDefault(); }); canvas.addEventListener("wheel", function(e){ window.scrollBy({ top:e.deltaY, left:e.deltaX, behavior:"auto" }); e.preventDefault(); }, { passive:false });
    var key = function(e) { if (e.key === "Escape") { window.__o8DesignDrawResult = { ok:false, escaped:true }; stopDesignDraw(); } }; window.addEventListener("keydown", key, true); __designDraw = { canvas:canvas, hint:hint, hover:hover, composer:composer, key:key }; return { ok:true, armed:true };
  }
  // Host-pushed thumbnail of the drawn region (preview only — the REAL
  // payload screenshot is captured fresh at SEND). The page cannot
  // screenshot itself, so NativeBrowserSurface captures + crops in the o8
  // webview and pushes the data: URI here. Fails silently if the page CSP
  // blocks data: img-src.
  function setDrawThumb(args) { try { var img = document.querySelector("[data-o8-design-composer] [data-o8-design-thumb]"); if (img && args && args.dataUri) { img.src = args.dataUri; img.style.display = "block"; return { ok: true }; } } catch (e) {} return { ok: false }; }
  // Read (without clearing) the region the host should capture a thumbnail
  // of — set at pointerup while the composer is open, cleared on the next
  // stroke. The host dedupes so a repeated read is cheap.
  function getDrawPending() { try { return window.__o8DesignDrawPending || null; } catch (e) { return null; } }


  // ── Design Mode click-to-grab (Stage 4b) ──
  // The operator clicks an element in the native window; the click lands HERE
  // (the native window owns the pointer), so o8\u2019s main-webview Design Mode
  // overlay can\u2019t see it. We install an in-page hover-highlight + one-shot
  // click handler that grabs elementFromPoint and POSTs the GrabbedElement back
  // through the same cid-only result channel.
  var __designGrab = null;
  function startDesignGrab() {
    stopDesignGrab();
    var hl = document.createElement('div');
    hl.setAttribute('data-o8-design-highlight', 'true');
    hl.setAttribute('style', 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,0.08);border-radius:6px;display:none;box-sizing:border-box;transition:left 60ms linear,top 60ms linear,width 60ms linear,height 60ms linear;');
    if (document.body) document.body.appendChild(hl);
    function onMove(e) {
      var t = document.elementFromPoint(e.clientX, e.clientY);
      if (!t || t === hl) { hl.style.display = 'none'; return; }
      var b = t.getBoundingClientRect();
      hl.style.display = 'block'; hl.style.left = b.left + 'px'; hl.style.top = b.top + 'px'; hl.style.width = b.width + 'px'; hl.style.height = b.height + 'px';
    }
    function onClick(e) {
      e.preventDefault(); e.stopPropagation();
      var t = document.elementFromPoint(e.clientX, e.clientY);
      var payload;
      try { payload = t ? { ok: true, element: buildGrabbedElement(t, selectorFor(t)) } : { ok: false, error: 'no element under cursor' }; }
      catch (err) { payload = { ok: false, error: String((err && err.message) || err) }; }
      stopDesignGrab();
      // Store for the host to PULL via browser_view_eval_result. The page can
      // not POST to o8's HTTP server from an HTTPS origin (mixed content), so
      // the native host reads this back instead of the page pushing it.
      try { window.__o8DesignGrabResult = payload; } catch (e2) {}
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    __designGrab = { hl: hl, onMove: onMove, onClick: onClick };
  }
  function stopDesignGrab() {
    if (!__designGrab) return;
    document.removeEventListener('mousemove', __designGrab.onMove, true);
    document.removeEventListener('click', __designGrab.onClick, true);
    if (__designGrab.hl && __designGrab.hl.parentNode) __designGrab.hl.parentNode.removeChild(__designGrab.hl);
    __designGrab = null;
  }

  window.__o8BrowserAgent = { read: read, localize: localize, rect: rect, click: click, type: type, probe: probe, grab: grab, drawmode: startDesignDraw, drawthumb: setDrawThumb, drawpending: getDrawPending, startDesignGrab: startDesignGrab, stopDesignGrab: stopDesignGrab };
})();
