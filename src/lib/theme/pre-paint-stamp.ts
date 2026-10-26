/**
 * Pre-paint theme stamp — the inline script that runs in `<head>` before first paint.
 *
 * It mirrors ThemeProvider's persisted-theme resolution (`./context.tsx`:
 * readPaletteId / readReduceTransparency / resolveSurface / effectiveWorkspaceGlass) so
 * `data-palette` / `data-surface` are truthful BEFORE hydration. The boot cover
 * (`--o8-boot-cover-*` in globals.css) and all pre-hydration chrome key off those attrs;
 * without the stamp a dark-palette operator paints a light shell until the provider's
 * effect runs.
 *
 * It lives here rather than inline in the layout so the resolution it mirrors can be
 * tested against the same cases as the provider — divergence between the two is the
 * failure mode this module exists to prevent. Keep the storage keys, the fallbacks, and
 * every branch in sync with context.tsx.
 */
export const PRE_PAINT_THEME_STAMP = `
  (function () {
    try {
      var ls = window.localStorage;
      var pal = ls.getItem('cortex-theme-palette');
      var legacy = ls.getItem('cortex-theme');
      var rt = ls.getItem('cortex-reduce-transparency');
      var hasPref = pal !== null || legacy !== null || rt !== null;
      if (pal !== 'light' && pal !== 'dark') {
        var remap = { light: 'light', midnight: 'dark', dark: 'dark', chocolate: 'dark' };
        pal = (legacy && remap[legacy]) || (hasPref ? 'dark' : 'light');
      }
      if (rt !== 'on' && rt !== 'off' && rt !== 'system') {
        rt = hasPref ? 'system' : 'on';
      }
      var surface = rt === 'on' ? 'solid' : 'glass';
      // Relayed into a browser there is no native vibrancy material to bleed
      // through, so glass paints as washed-out grey. Mirrors the web-machine
      // branches in context.tsx (resolveSurface forceSolid +
      // effectiveWorkspaceGlass): surface pins to solid, All Glass is ignored so
      // the stored palette still shows, and nothing is written back.
      var webMachine = document.querySelector('meta[name="o8-auth-mode"]')
        ?.getAttribute('content') === 'web-machine';
      // Windows / Linux shells have no vibrancy material either (#1743), so
      // they take the same solid path. The global is stamped by the Rust
      // initialization script at document-start — see lib/desktop/host-platform.ts.
      // Local Linux patch: O8_LINUX_GLASS=1 (window.__O8_LINUX_GLASS__) keeps
      // the glass styling on Linux over a painted backdrop.
      var linuxGlass = window.__O8_HOST_PLATFORM__ === 'linux' && window.__O8_LINUX_GLASS__ === true;
      var nonMacShell = (window.__O8_HOST_PLATFORM__ === 'windows'
        || window.__O8_HOST_PLATFORM__ === 'linux') && !linuxGlass;
      var noVibrancy = webMachine || nonMacShell;
      // ALL GLASS mode overrides both axes wholesale (mirrors effectiveSurface /
      // getPalette('dark') in context.tsx: workspace glass forces the dark-glass
      // theme regardless of the stored palette/transparency prefs). Missing this
      // painted a cream cover under a dark-glass boot.
      var storedGlass = ls.getItem('cortex-workspace-glass');
      var freshMacGlass = window.__O8_HOST_PLATFORM__ === 'macos'
        && storedGlass === null && !hasPref;
      if (linuxGlass && storedGlass === null) freshMacGlass = true;
      if (!noVibrancy && (storedGlass === 'true' || freshMacGlass)) {
        pal = 'dark';
        surface = 'glass';
      }
      if (noVibrancy) surface = 'solid';
      var el = document.documentElement;
      if (linuxGlass) el.dataset.linuxGlass = 'true';
      el.dataset.theme = pal;
      el.dataset.palette = pal;
      el.dataset.surface = surface;
      // Inline cover vars — the boot cover must paint the right theme even BEFORE
      // the stylesheet applies (the packaged webview painted the inline cream
      // fallback for ~1s on a dark-glass machine, a cream blink between the dark
      // native splash and the dark cover). Values mirror the --o8-boot-cover-*
      // block in globals.css.
      var coverBg = surface === 'glass'
        ? 'linear-gradient(180deg, rgb(32, 36, 42) 0%, rgb(18, 20, 24) 100%)'
        : (pal === 'dark' ? '#242424' : '#F4F2ED');
      var coverInk = surface === 'glass'
        ? 'rgba(244, 244, 245, 0.5)'
        : (pal === 'dark' ? 'rgba(232, 236, 242, 0.45)' : 'rgba(15, 23, 42, 0.45)');
      el.style.setProperty('--o8-boot-cover-bg', coverBg);
      el.style.setProperty('--o8-boot-cover-ink', coverInk);
    } catch (e) {}
  })();
`;
