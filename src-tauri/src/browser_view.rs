//! Native host-owned child webview for the embedded Browser pane.
//!
//! A SECOND top-level Tauri window — label **`browser-view`**, NEVER `main` —
//! navigated DIRECTLY to the user's localhost app (`WebviewUrl::External`). It is
//! positioned over the right-panel's Browser content rect and made a macOS *child
//! window* of `main` (`addChildWindow:ordered:`) so it tracks the app as it moves.
//!
//! Why a native child window instead of an iframe/proxy (see
//! `docs/internals/native-browser-webview-spec.md`):
//!   - A native top-level webview renders origin-sensitive auth apps (Clerk)
//!     **smoothly** — real origin, first-party storage, no WebKit cross-origin
//!     iframe storage partitioning, no proxy origin rewrite.
//!   - The native host can `eval` into a webview it owns, which runs in the page's
//!     main world with full DOM access AT ANY ORIGIN — same-origin policy binds
//!     *web frames*, not the native host. That is what makes grab + agent-drive
//!     work where an iframe never could.
//!
//! Label discipline is load-bearing (mirrors `dock_window.rs`): the dev-mcp
//! plugin's `.default_webview_label("main")`, the updater + console-error
//! page-load hooks, `apply_vibrancy(HudWindow)`, and the DragDrop bridge all key
//! off `"main"` and must stay blind to this window. The `o8_view_*` webview tools
//! target `"main"`; the new grab/agent path targets `"browser-view"` (Stage 4).
//!
//! Coordinate model: the React panel reports its content rect via
//! `getBoundingClientRect()` in **CSS logical px** relative to the main webview's
//! viewport top-left. We convert to physical screen coords by anchoring at the
//! main window's content origin (`inner_position()`) and scaling by
//! `scale_factor()` — the same Retina gotcha documented for `o8_view_screenshot`
//! (physical px = CSS px × scaleFactor).

#[cfg(target_os = "macos")]
pub const BROWSER_VIEW_LABEL: &str = "browser-view";

/// Last applied content rect (CSS logical px, relative to the main webview
/// viewport): `(x, y, w, h)`. Stored so `show()` and monitor/scale changes can
/// re-apply the position without the panel re-reporting it.
#[cfg(target_os = "macos")]
static LAST_RECT: std::sync::Mutex<Option<(f64, f64, f64, f64)>> =
    std::sync::Mutex::new(None);

#[cfg(target_os = "macos")]
fn store_rect(x: f64, y: f64, w: f64, h: f64) {
    let mut slot = LAST_RECT.lock().unwrap_or_else(|p| p.into_inner());
    *slot = Some((x, y, w, h));
}

#[cfg(target_os = "macos")]
fn validate_page_zoom(zoom: f64) -> Result<(), String> {
    if !zoom.is_finite() || zoom <= 0.0 {
        return Err("[browser-view] page zoom must be finite and positive".into());
    }
    Ok(())
}

/// Open (or re-target) the browser-view child window over `(x, y, w, h)` and
/// navigate it to `url`. Idempotent: a second call navigates + repositions the
/// existing window instead of creating a new one. CSS logical px in; converted to
/// physical screen coords against the main window. Returns a string error so the
/// React side can surface a bad URL.
///
/// `init_script` (the panel passes `NATIVE_BROWSER_AGENT_SOURCE`) is registered
/// via `.initialization_script` so `window.__o8BrowserAgent` installs in the page
/// (every navigation, before page JS, main world) WITHOUT any Tauri capability —
/// the native host evals into a webview it owns, which needs no IPC bridge. This
/// keeps the untrusted localhost page free of `__TAURI_INTERNALS__` (see
/// `native_browser_view_security` memory). The init script is baked at build time,
/// so it only applies on first open; later opens reuse the existing window.
#[cfg(target_os = "macos")]
pub fn open(
    app: &tauri::AppHandle,
    url: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    init_script: Option<&str>,
    page_zoom: f64,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    validate_page_zoom(page_zoom)?;
    store_rect(x, y, w, h);

    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("[browser-view] bad url {url}: {e}"))?;

    // Already exists → navigate + reposition + show.
    if let Some(win) = app.get_webview_window(BROWSER_VIEW_LABEL) {
        if let Err(e) = win.navigate(parsed) {
            log::warn!("[browser-view] navigate failed: {e}");
        }
        win.set_zoom(page_zoom).map_err(|e| format!("[browser-view] zoom failed: {e}"))?;
        reposition(app, &win, x, y, w, h);
        let _ = win.show();
        return Ok(());
    }

    // Build hidden at the target size, position it, THEN show — so it never
    // flashes at the default center before snapping over the panel rect.
    let mut builder = WebviewWindowBuilder::new(app, BROWSER_VIEW_LABEL, WebviewUrl::External(parsed))
        .title("o8 browser")
        .inner_size(w.max(1.0), h.max(1.0))
        .decorations(false)
        .shadow(false)
        // Don't yank focus from the app shell when the pane mounts; the user
        // clicking into the page makes it key naturally (unlike the dock, we do
        // NOT pin a nonactivating posture — the page needs to accept keyboard).
        .focused(false)
        .visible(false)
        // OS drag-drop bridge is main-only; avoid the transparent+hardened
        // DragDrop crash trap (see `dragdropenabled_macos_trap` memory).
        .disable_drag_drop_handler();
    if let Some(script) = init_script {
        builder = builder.initialization_script(script);
    }
    let win = builder
        .build()
        .map_err(|e| format!("[browser-view] failed to build window: {e}"))?;

    win.set_zoom(page_zoom).map_err(|e| format!("[browser-view] zoom failed: {e}"))?;
    reposition(app, &win, x, y, w, h);
    let _ = win.show();
    // Make it a child of `main` so it tracks the app's movement and stays above
    // the main window's web content (occlusion of o8 overlays is handled in
    // Stage 5 via snapshot-swap).
    attach_as_child(app, &win);
    // Round the BOTTOM corners so the child window reads as one card with the
    // right panel's Lisse (14px squircle) corners in glass mode — otherwise the
    // native window's square bottom paints over the panel's rounded corner and
    // reads dead-square (operator, 2026-07-14). Applied once on build; the layer
    // clip tracks resize, so set_rect/show don't need to re-apply.
    round_bottom_corners(&win, 14.0);
    log::info!("[browser-view] opened → {url}");
    Ok(())
}

/// Reposition/resize the existing child window over a new content rect. Called by
/// the panel's ResizeObserver / window move+resize listeners. No-op if the window
/// isn't open.
#[cfg(target_os = "macos")]
pub fn set_rect(app: &tauri::AppHandle, x: f64, y: f64, w: f64, h: f64, page_zoom: f64) -> Result<(), String> {
    use tauri::Manager;
    validate_page_zoom(page_zoom)?;
    store_rect(x, y, w, h);
    if let Some(win) = app.get_webview_window(BROWSER_VIEW_LABEL) {
        win.set_zoom(page_zoom).map_err(|e| format!("[browser-view] zoom failed: {e}"))?;
        reposition(app, &win, x, y, w, h);
    }
    Ok(())
}

/// Eval `js` into the browser-view page — raw, fire-and-forget. The native host
/// owns this webview, so eval runs in the page's main world at ANY origin with
/// no IPC bridge / Tauri capability (same-origin policy binds web frames, not the
/// host). Returns whether the window existed (so the caller can fall back to the
/// iframe path when native isn't up). The injected JS returns its result to o8 by
/// POSTing to /api/browser/native-result (the narrow cid-only secure channel),
/// NEVER via `__TAURI_INTERNALS__` — the untrusted page deliberately has no IPC
/// bridge (see `native_browser_view_security` memory).
#[cfg(target_os = "macos")]
pub fn eval(app: &tauri::AppHandle, js: &str) -> bool {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window(BROWSER_VIEW_LABEL) {
        if let Err(e) = win.eval(js) {
            log::warn!("[browser-view] eval failed: {e}");
        }
        true
    } else {
        false
    }
}

/// Eval `js` in the browser-view and RETURN its result (JSON-encoded).
///
/// Unlike `eval` (fire-and-forget), this captures the WKWebView
/// `evaluateJavaScript:completionHandler:` return value — the host reading a value
/// back from a webview it OWNS, which works at ANY page origin. That is the fix for
/// the agent result channel: the in-page agent's own `fetch` POST to the local o8
/// server is App-Transport-Security / mixed-content blocked on HTTPS pages
/// (`TypeError: Load failed`), so the host PULLS the JSON the verb returns instead
/// of the page pushing it over HTTP. `js` should evaluate to a JSON-serializable
/// value; the completion result is NSJSON-encoded to a string (null → empty). Errs
/// if the window is gone or the completion never fires within `timeout_ms`.
#[cfg(target_os = "macos")]
pub async fn eval_result(app: &tauri::AppHandle, js: String, timeout_ms: u64) -> Result<String, String> {
    use tauri::Manager;
    let win = app
        .get_webview_window(BROWSER_VIEW_LABEL)
        .ok_or_else(|| "browser-view not open".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));

    win.with_webview(move |webview| {
        // with_webview runs this closure on the main thread; WKWebView is
        // main-thread only. The completion handler fires LATER on the main thread —
        // safe because the awaiting command runs on the async runtime, not main.
        use block2::RcBlock;
        use objc2::{runtime::AnyObject, AnyThread};
        use objc2_foundation::{
            NSError, NSJSONSerialization, NSJSONWritingOptions, NSString, NSUTF8StringEncoding,
        };
        use objc2_web_kit::WKWebView;
        // Safety: Tauri hands us the live WKWebView for this window's lifetime; the
        // objc2 calls below mirror wry's own `eval` completion-handler path.
        unsafe {
            let view: &WKWebView = &*webview.inner().cast();
            let handler = RcBlock::new(move |val: *mut AnyObject, _err: *mut NSError| {
                let mut result = String::new();
                if !val.is_null() {
                    if let Ok(data) = NSJSONSerialization::dataWithJSONObject_options_error(
                        &*val,
                        NSJSONWritingOptions::FragmentsAllowed,
                    ) {
                        let s = NSString::alloc();
                        if let Some(s) = NSString::initWithData_encoding(s, &data, NSUTF8StringEncoding) {
                            result = s.to_string();
                        }
                    }
                }
                // JS `null`/`undefined` return as NSNull (a real object, not nil), so
                // NSJSON yields the string "null". Normalize to empty so callers can
                // treat "" as "no value yet" — the design-grab poll depends on this.
                if result == "null" {
                    result.clear();
                }
                if let Ok(mut guard) = tx.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(result);
                    }
                }
            });
            view.evaluateJavaScript_completionHandler(&NSString::from_str(&js), Some(&handler));
        }
    })
    .map_err(|e| format!("with_webview failed: {e}"))?;

    match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(_)) => Err("browser-view eval channel closed".to_string()),
        Err(_) => Err("browser-view eval timed out".to_string()),
    }
}

/// Navigate the existing child window to a new URL (URL bar / tab switch /
/// reload). No-op if the window isn't open.
#[cfg(target_os = "macos")]
pub fn navigate(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    use tauri::Manager;
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("[browser-view] bad url {url}: {e}"))?;
    if let Some(win) = app.get_webview_window(BROWSER_VIEW_LABEL) {
        win.navigate(parsed)
            .map_err(|e| format!("[browser-view] navigate failed: {e}"))?;
    }
    Ok(())
}

/// Close + destroy the child window (Browser tab closed / app teardown).
#[cfg(target_os = "macos")]
pub fn close(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window(BROWSER_VIEW_LABEL) {
        let _ = win.close();
    }
}

/// Hide the child window without destroying it (Browser tab not visible, panel
/// collapsed, occlusion snapshot-swap). Cheaper than close — `show()` brings it
/// back without a fresh navigate.
#[cfg(target_os = "macos")]
pub fn hide(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window(BROWSER_VIEW_LABEL) {
        let _ = win.hide();
    }
}

/// Show the child window again and re-apply the last known rect (the active
/// monitor/scale may have changed while hidden).
#[cfg(target_os = "macos")]
pub fn show(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window(BROWSER_VIEW_LABEL) {
        let _ = win.show();
        if let Some((x, y, w, h)) = *LAST_RECT.lock().unwrap_or_else(|p| p.into_inner()) {
            reposition(app, &win, x, y, w, h);
        }
    }
}

/// Position and size child content in the parent's logical coordinate space.
/// A newly created child can initially have another display's scale factor;
/// passing physical coordinates would let that scale shift and enlarge it.
#[cfg(target_os = "macos")]
pub(crate) fn reposition(app: &tauri::AppHandle, win: &tauri::WebviewWindow, x: f64, y: f64, w: f64, h: f64) {
    use tauri::{LogicalPosition, LogicalSize, Manager};
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let scale = main.scale_factor().unwrap_or(1.0);
    let Ok(origin) = main.inner_position() else {
        return;
    };
    let logical_x = origin.x as f64 / scale + x;
    let logical_y = origin.y as f64 / scale + y;
    let _ = win.set_position(LogicalPosition::new(logical_x, logical_y));
    let _ = win.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)));
    // Re-assert the child-above-parent relationship on every reposition. set_size /
    // set_position drop the child behind the parent — visible on a resize-GROW, where
    // the parent's frame expands over the child's area and never re-orders it above
    // (shrink covers less, so it survived; the operator hit this going full-screen →
    // windowed). addChildWindow is idempotent for the same parent, so re-adding here
    // keeps it ordered above through open(), set_rect() (resize/scroll), and show().
    attach_as_child(app, win);
}

/// Make the child window a macOS child of `main` via `addChildWindow:ordered:`.
/// The child then moves with the parent and stays ordered above it. Raw
/// `objc2 msg_send` (the proven in-repo pattern from `round_window_corners`) to
/// avoid binding/feature uncertainty. Runs on the calling thread, which for a
/// Tauri command body is the main thread (NSWindow mutations are main-thread
/// only — mirrors `open_voice_settings` calling `round_window_corners` inline).
#[cfg(target_os = "macos")]
fn attach_as_child(app: &tauri::AppHandle, child: &tauri::WebviewWindow) {
    use objc2::{msg_send, runtime::AnyObject};
    use tauri::Manager;

    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let main_ptr = match main.ns_window() {
        Ok(p) if !p.is_null() => p as *mut AnyObject,
        _ => return,
    };
    let child_ptr = match child.ns_window() {
        Ok(p) if !p.is_null() => p as *mut AnyObject,
        _ => return,
    };
    // NSWindowOrderingMode::Above == 1.
    let ordered: isize = 1;
    // Safety: Tauri guarantees live NSWindows for the windows' lifetimes; a Tauri
    // command body runs on the main thread.
    unsafe {
        let _: () = msg_send![main_ptr, addChildWindow: child_ptr, ordered: ordered];
    }
}

/// Round the browser-view window's BOTTOM corners so it matches the right panel's
/// Lisse squircle (`SmoothCorners radius:14`) and never runs dead-square into the
/// panel's rounded bottom edge in glass mode.
///
/// Clips the NSWindow content-view layer (which contains the WKWebView, same as
/// `round_window_corners` in `lib.rs`) with the CONTINUOUS corner curve — the
/// Apple squircle, `kCACornerCurveContinuous` == the NSString `"continuous"` — so
/// it reads like the web-layer Lisse corners rather than a plain circular arc.
/// `masksToBounds` makes the clip track the window bounds, so the corners stay
/// round through every `reposition` resize.
///
/// BOTTOM-ONLY, not all four: the window's top edge butts flush under the pane's
/// URL-toolbar divider (a straight horizontal seam, NOT a panel corner), so
/// rounding the top would notch the page under the toolbar. The content view's
/// backing layer is not geometry-flipped, so `minY` is the VISUAL bottom →
/// `kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner`.
///
/// The radius is in LAYER POINTS, which equal CSS px (the window frame is sized
/// in physical px, but the backing layer's coordinate space is points), so 14.0
/// matches the 14px web radius directly — no `scale_factor` multiply.
///
/// The window is made non-opaque with a clear background so the clipped-away
/// corner triangles reveal the panel beneath instead of the opaque window
/// backing. The WKWebView keeps drawing its own opaque page background inside the
/// rounded rect, so the page itself never turns translucent.
#[cfg(target_os = "macos")]
fn round_bottom_corners(win: &tauri::WebviewWindow, radius: f64) {
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_app_kit::NSColor;
    use objc2_foundation::NSString;

    let win_ptr = match win.ns_window() {
        Ok(p) if !p.is_null() => p as *mut AnyObject,
        _ => return,
    };
    // kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner (see doc comment: minY is
    // the visual bottom for this non-flipped content-view layer).
    let bottom_corners: usize = (1 << 0) | (1 << 1);
    // Safety: Tauri guarantees a live NSWindow for the window's lifetime; a Tauri
    // command body (open()'s caller) runs on the main thread — mirrors
    // attach_as_child + round_window_corners.
    unsafe {
        let _: () = msg_send![win_ptr, setOpaque: false];
        let clear = NSColor::clearColor();
        let _: () = msg_send![win_ptr, setBackgroundColor: &*clear];

        let content: *mut AnyObject = msg_send![win_ptr, contentView];
        if content.is_null() {
            return;
        }
        let _: () = msg_send![content, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![content, layer];
        if layer.is_null() {
            return;
        }
        let continuous = NSString::from_str("continuous");
        let _: () = msg_send![layer, setCornerCurve: &*continuous];
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMaskedCorners: bottom_corners];
        let _: () = msg_send![layer, setMasksToBounds: true];
    }
}

// ── Non-macOS no-ops (o8 ships the native browser-view on macOS only) ──
#[cfg(not(target_os = "macos"))]
pub fn open(
    _app: &tauri::AppHandle,
    _url: &str,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
    _init_script: Option<&str>,
    _page_zoom: f64,
) -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "macos"))]
pub fn set_rect(_app: &tauri::AppHandle, _x: f64, _y: f64, _w: f64, _h: f64, _page_zoom: f64) -> Result<(), String> { Ok(()) }
#[cfg(not(target_os = "macos"))]
pub fn eval(_app: &tauri::AppHandle, _js: &str) -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub async fn eval_result(_app: &tauri::AppHandle, _js: String, _timeout_ms: u64) -> Result<String, String> {
    Err("native browser-view is macOS-only".to_string())
}
#[cfg(not(target_os = "macos"))]
pub fn navigate(_app: &tauri::AppHandle, _url: &str) -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "macos"))]
pub fn close(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn hide(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn show(_app: &tauri::AppHandle) {}
