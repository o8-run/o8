/* o8 working indicator v1, web reference (site, web app, previews).
   Native GPUI uses the PNG frames in frames-80/ instead; see docs/design/BRAND-IMPLEMENT.md.
   Usage:
     const w = O8Working.mount(el, { base: "/brand/working/composer/" });
     w.set("review", "Reviewing #5938 · 14 files");   // switches when the current loop ends
     w.stop();                                          // hide when the turn ends
   States: thinking, arrive, review, sendback, waiting, rereview, merging, approved (states.json). */
(function (g) {
  var LOOP = { thinking: 4, arrive: 6.5, review: 7.5, sendback: 6, waiting: 7, rereview: 8, merging: 7, approved: 7 };
  var FADE = 300, seq = 0, cache = {};
  function load(base, key) {
    if (!cache[base + key]) cache[base + key] = fetch(base + key + ".svg").then(function (r) { return r.text(); });
    return cache[base + key];
  }
  function mount(el, opts) {
    opts = opts || {};
    var base = opts.base || "/brand/working/composer/";
    var reduce = false; try { reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch {}
    el.classList.add("o8w");
    el.innerHTML = '<span class="o8w-face"></span><span class="o8w-line"></span><span class="o8w-time"></span>';
    var face = el.querySelector(".o8w-face"), line = el.querySelector(".o8w-line"), time = el.querySelector(".o8w-time");
    var cur = null, svg = null, pending = null, loops = 0, start = performance.now(), raf = 0;
    function show(key, text) {
      cur = key; line.textContent = text || "";
      return load(base, key).then(function (txt) {
        seq++;
        var layer = document.createElement("span"); layer.className = "o8w-layer";
        layer.innerHTML = txt.replace(/\b(gb|hs|gf|rk|ik)(\d*)/g, "$1$2w" + seq + "_");  // ids stay unique per layer
        var old = [].slice.call(face.children); face.appendChild(layer);
        old.forEach(function (o) { o.classList.add("o8w-gone"); setTimeout(function () { o.remove(); }, FADE + 50); });
        svg = layer.querySelector("svg"); loops = 0;
        try { svg.setCurrentTime(0); if (reduce) svg.pauseAnimations(); } catch {}
      });
    }
    function tick() {
      var s = (performance.now() - start) / 1000;
      time.textContent = Math.floor(s / 60) + ":" + ("0" + Math.floor(s % 60)).slice(-2) + " · esc to stop";
      if (svg && pending && !reduce) {
        var t = 0; try { t = svg.getCurrentTime(); } catch {}
        var n = Math.floor(t / LOOP[cur]);
        if (n > loops) { var p = pending; pending = null; show(p.key, p.text); }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return {
      set: function (key, text) {
        if (!LOOP[key]) throw new Error("unknown o8 working state: " + key);
        if (cur === null || reduce) return show(key, text);
        if (key === cur) { line.textContent = text || line.textContent; pending = null; return; }
        pending = { key: key, text: text };   // switch only when the current loop lands
      },
      stop: function () { cancelAnimationFrame(raf); el.innerHTML = ""; el.classList.remove("o8w"); }
    };
  }
  g.O8Working = { mount: mount, states: Object.keys(LOOP) };
})(window);
