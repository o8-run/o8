//! Screen-level dock pill window (system-wide Symon fold P3).
//!
//! A SECOND always-on-top, transparent Tauri window — label **`dock`**, NEVER
//! `main`. Label discipline is load-bearing: the dev-mcp plugin's
//! `.default_webview_label('main')`, the updater's main-window page-load hook,
//! `apply_vibrancy(HudWindow)`, the DragDrop bridge, and the console-error hook
//! all key off `main` and must stay blind to this window.
//!
//! It loads the bundled-Next route `/dictation-pill` (mirrors main → /dashboard)
//! and shows the morphing Symon pill at the TOP of the screen during global-Fn
//! (system) dictation, so the user sees it without o8 focused. The in-window
//! pill (DictationHost) is untouched and only shows on the mic-button path.
//!
//! macOS recipe (ported from aqua/Symon `set_macos_window_level` +
//! `resize_and_reposition_pill_window`):
//!   - NSWindow backgroundColor = clearColor + setOpaque(false): the window is
//!     transparent so only the pill paints (NOT HudWindow vibrancy — that dark
//!     material would gray out the light pill).
//!   - setLevel(25): one above the menu bar (level 24) so it hangs over the
//!     true top of the screen.
//!   - primary-screen top-center anchor: x centered, y = screen origin_y
//!     (flush to top edge).
//!   - NONACTIVATING: the window must never become key / steal focus from the
//!     app the user is dictating into. Tauri windows are plain NSWindows (not
//!     NSPanels) so `canBecomeKey` can't be overridden without subclassing; the
//!     reliable combination is window-config `focus:false` + showing via
//!     `orderFrontRegardless` (orders front WITHOUT activating) +
//!     `setHidesOnDeactivate(false)` + a Stationary/CanJoinAllSpaces collection
//!     behavior so it sits across spaces without grabbing key state.

#[cfg(target_os = "macos")]
pub const DOCK_LABEL: &str = "dock";

/// Window-local logical rect of the PAINTED pill content, reported by the
/// React layer (`dock_set_hit_rect`) on every morph. None until the page
/// hydrates — and None means CLICK-THROUGH, so a dead webview never blocks
/// clicks at the top of the screen.
#[cfg(target_os = "macos")]
static HIT_RECT: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);
#[cfg(target_os = "macos")]
static EXPANDED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Logical size of the dock window. The pill content centers inside this; the
/// React layer keeps the dead-zone tight (pointer-events: none on the wrapper).
#[cfg(target_os = "macos")]
const DOCK_WIDTH: f64 = 520.0;
#[cfg(target_os = "macos")]
const DOCK_HEIGHT: f64 = 120.0;
/// Expanded height for the Ask answer panel (voice P4 phase C). The dock grows
/// from the compact pill to this taller window so the panel (question + answer +
/// context, ~440×360) has room; it shrinks back to `DOCK_HEIGHT` on collapse.
/// Only tall WHILE the panel is up, so the larger click-capturing region never
/// covers the top of the screen at rest.
#[cfg(target_os = "macos")]
const DOCK_EXPANDED_HEIGHT: f64 = 420.0;
/// Top inset below the true screen origin. ZERO so the window top sits flush at
/// the very top edge of the screen — the idle capsule's square top edge
/// (borderRadius 0 0 14 14) then hangs down from y=0 like the Symon notch.
/// The window is level 25 (above the menu bar at 24), so overlapping the
/// menu-bar zone is fine. Mirrors aqua's NotchSurface / resize_symon_window
/// notch branch where y = mon_y.
#[cfg(target_os = "macos")]
const DOCK_TOP_INSET: f64 = 0.0;

/// Create the dock window and navigate it to `/dictation-pill` on the bundled
/// Next server, then apply the macOS transparency + level + anchor recipe.
/// Idempotent: a second call is a no-op if the window already exists.
///
/// ALWAYS-ON: the window is built `.visible(true)` and shown persistently at
/// boot (ordered front nonactivating) so the Symon idle capsule paints at the
/// top of the screen from launch — it never starts hidden. The `/dictation-pill`
/// route always paints at least the idle capsule (`persistentIdle`), and the
/// system Fn path MORPHS it (idle → recording → polishing → success → idle)
/// rather than showing/hiding the window.
///
/// Call this from `setup()` AFTER the bundled Next server is confirmed up
/// (mirrors the main → /dashboard loader pattern). `api_port` is the resolved
/// Next port written to ~/.o8/api-port.
#[cfg(target_os = "macos")]
pub fn create(app: &tauri::AppHandle, api_port: u16) {
    use tauri::Manager;

    if app.get_webview_window(DOCK_LABEL).is_some() {
        return;
    }
    EXPANDED.store(false, std::sync::atomic::Ordering::Release);

    // In dev-bridge mode (O8_DEV_FRONTEND_URL set), load the dock from the dev
    // Next server too — otherwise it would load the BUNDLED frontend off
    // `api_port` while `main` hot-reloads from dev, and dock UI edits wouldn't
    // show. The dock capability's remote.urls already covers `http://localhost:*`.
    let base = match crate::dev_frontend::from_env() {
        Ok(Some(dev)) => {
            log::info!(
                "[dock-window] dev-bridge: loading dock from {}",
                dev.origin()
            );
            dev.origin().to_string()
        }
        _ => format!("http://127.0.0.1:{}", api_port),
    };
    let url = format!("{}/dictation-pill", base);
    create_at_url(app, &url);
}

/// Voice-only feedback is bundled locally and has no server prerequisite.
#[cfg(target_os = "macos")]
pub fn create_voice_only(app: &tauri::AppHandle) {
    create_at_url(app, "o8-voice://localhost/index.html");
}

#[cfg(target_os = "macos")]
fn create_at_url(app: &tauri::AppHandle, url: &str) {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let parsed = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("[dock-window] bad url {url}: {e}");
            return;
        }
    };

    let window = WebviewWindowBuilder::new(app, DOCK_LABEL, WebviewUrl::External(parsed))
        .title("o8 dictation")
        .inner_size(DOCK_WIDTH, DOCK_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .skip_taskbar(true)
        // Nonactivating: do NOT make the window key/focused when it appears.
        .focused(false)
        // ALWAYS-ON: created visible so the idle capsule paints from boot. The
        // underlying app keeps focus — we never make this window key (see
        // order_front_nonactivating below).
        .visible(true)
        // OS-level drag-drop bridge is main-only; the dock takes no drops.
        // dragDropEnabled:false on this window.
        .disable_drag_drop_handler()
        .build();

    let window = match window {
        Ok(w) => w,
        Err(e) => {
            log::warn!("[dock-window] failed to build dock window: {e}");
            return;
        }
    };

    apply_macos_recipe(&window);
    resize_and_reposition(&window);
    // CLICK-THROUGH by default. The window frame is a 520-wide strip at the
    // top of the screen — far larger than the painted pill — and macOS routes
    // every click in a window's frame to that window regardless of pixel
    // alpha, so a non-ignoring dock hijacks clicks meant for whatever sits
    // under the transparent area (menu bar, a terminal title bar). The
    // hit-test poller below flips events ON only while the cursor is over the
    // pill rect that React reports via `dock_set_hit_rect`.
    let _ = window.set_ignore_cursor_events(true);
    spawn_hit_test_poller(app.clone());
    // ALWAYS-ON: order it front WITHOUT making it key so the idle capsule is on
    // screen from boot. The window was built `.visible(true)`, but on some Tauri
    // versions a borderless transparent window built shown still needs an
    // explicit nonactivating order-front to actually display — and the app the
    // user is in keeps focus (we never call makeKeyAndOrderFront).
    order_front_nonactivating(&window);
    log::info!("[dock-window] dock pill window created (always-on) → {url}");
}

/// Re-assert the always-on dock pill. The window is created visible at boot and
/// stays up, so this is no longer a "show from hidden" — it re-anchors (the
/// primary monitor geometry may have changed), re-applies the recipe, and
/// re-orders it front WITHOUT making it key, so the app the user is dictating
/// into keeps focus. Safe to call on system Fn-down (belt-and-suspenders
/// re-assert) and from `o8_debug_show_dock`.
#[cfg(target_os = "macos")]
pub fn show(app: &tauri::AppHandle) {
    use tauri::Manager;
    // #2147 — quiet mode owns overlay visibility for its duration. Without this
    // the dock re-asserts itself on the next Fn press and lands back on screen
    // mid-presentation.
    if crate::presentation::overlay_show_blocked() {
        return;
    }
    let Some(window) = app.get_webview_window(DOCK_LABEL) else {
        return;
    };
    resize_and_reposition(&window);
    apply_macos_recipe(&window);
    order_front_nonactivating(&window);
}

/// Grow / shrink the dock window for the Ask answer panel (voice P4 phase C).
/// Resizes between the compact pill height and `DOCK_EXPANDED_HEIGHT`, keeping
/// the top-center anchor, then re-orders front nonactivating. The React panel in
/// `/dictation-pill` calls this (via a custom command) when it opens/collapses
/// the Ask thread — the resize lives on the Rust side so the dock keeps its
/// label-disciplined "no window-control perms in the webview" posture. No-op if
/// the window is missing. Programmatic resize works despite `resizable(false)`
/// (that only blocks user drag-resize).
#[cfg(target_os = "macos")]
pub fn set_expanded(app: &tauri::AppHandle, expanded: bool) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(DOCK_LABEL) else {
        return;
    };
    EXPANDED.store(expanded, std::sync::atomic::Ordering::Release);
    resize_and_reposition(&window);
    order_front_nonactivating(&window);
}

/// Hide the dock pill. NOT called on the normal dictation flow anymore — the
/// dock is ALWAYS-ON and morphs idle ↔ recording ↔ success in place rather than
/// hiding. Retained for future use (e.g. an explicit "hide dock" toggle). No-op
/// if missing.
#[cfg(target_os = "macos")]
#[allow(dead_code)] // always-on dock: retained for a future explicit hide toggle.
pub fn hide(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window(DOCK_LABEL) {
        let _ = window.hide();
    }
}

/// Record the painted pill's window-local logical rect (from the React layer,
/// via the `dock_set_hit_rect` command). The poller compares the cursor
/// against THIS, not the window frame.
#[cfg(target_os = "macos")]
pub fn set_hit_rect(x: f64, y: f64, w: f64, h: f64) {
    let mut slot = HIT_RECT.lock().unwrap_or_else(|p| p.into_inner());
    *slot = Some((x, y, w, h));
}

/// Cursor-driven click-through toggle (the overlay-app pattern). While the
/// global cursor sits over the reported pill rect, the window accepts events
/// (buttons, taps, file drags); everywhere else in the frame it is
/// click-through. Ignored windows receive NO input — including drag events —
/// so the poller is the only thing that can let a Finder drag reach the drop
/// zone: dragging across the pill rect flips events on, the dragenter fires,
/// the zone morphs wider, React reports the bigger rect, and the poller keeps
/// events on over it. Adaptive cadence: 40ms while the cursor is inside the
/// window frame, 200ms otherwise — one cursor read per tick, negligible.
#[cfg(target_os = "macos")]
fn spawn_hit_test_poller(app: tauri::AppHandle) {
    use tauri::Manager;
    std::thread::spawn(move || {
        let mut ignoring = true;
        loop {
            let Some(window) = app.get_webview_window(DOCK_LABEL) else {
                std::thread::sleep(std::time::Duration::from_millis(500));
                continue;
            };
            let (over_pill, in_frame) = cursor_probe(&app, &window).unwrap_or((false, false));
            if over_pill == ignoring {
                ignoring = !over_pill;
                let _ = window.set_ignore_cursor_events(ignoring);
            }
            let tick = if in_frame { 40 } else { 200 };
            std::thread::sleep(std::time::Duration::from_millis(tick));
        }
    });
}

/// (cursor over the pill rect, cursor inside the window frame) — both in
/// physical px. The hit rect is padded 4 logical px so edges stay forgiving.
#[cfg(target_os = "macos")]
fn cursor_probe(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Option<(bool, bool)> {
    let cursor = app.cursor_position().ok()?;
    let win_pos = window.outer_position().ok()?;
    let win_size = window.outer_size().ok()?;
    let scale = window.scale_factor().ok()?;

    let in_frame = cursor.x >= win_pos.x as f64
        && cursor.x < (win_pos.x + win_size.width as i32) as f64
        && cursor.y >= win_pos.y as f64
        && cursor.y < (win_pos.y + win_size.height as i32) as f64;
    if !in_frame {
        return Some((false, false));
    }

    let rect = { *HIT_RECT.lock().unwrap_or_else(|p| p.into_inner()) };
    let Some((x, y, w, h)) = rect else {
        return Some((false, true));
    };
    let pad = 4.0 * scale;
    let rx = win_pos.x as f64 + x * scale - pad;
    let ry = win_pos.y as f64 + y * scale - pad;
    let rw = w * scale + pad * 2.0;
    let rh = h * scale + pad * 2.0;
    let over = cursor.x >= rx && cursor.x < rx + rw && cursor.y >= ry && cursor.y < ry + rh;
    Some((over, true))
}

/// Apply the transparent + level-25 + nonactivating NSWindow recipe. Runs on
/// the main thread (NSWindow mutations are main-thread-only). Idempotent.
#[cfg(target_os = "macos")]
fn apply_macos_recipe(window: &tauri::WebviewWindow) {
    let win = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::{NSColor, NSWindow, NSWindowCollectionBehavior};
        let Ok(ptr) = win.ns_window() else {
            return;
        };
        let ptr = ptr as *mut NSWindow;
        if ptr.is_null() {
            return;
        }
        // Safety: Tauri guarantees a live NSWindow for the window's lifetime;
        // this closure runs on the main thread.
        unsafe {
            let ns_window = &*ptr;
            // Transparent: only the pill paints, no opaque rectangle. Do NOT
            // apply HudWindow vibrancy here — dark material grays the light pill.
            let clear = NSColor::clearColor();
            ns_window.setBackgroundColor(Some(&clear));
            ns_window.setOpaque(false);
            // Level 25 = one above the menu bar (24): hangs over the top of the
            // screen. NSWindowLevel is NSInteger.
            ns_window.setLevel(25);
            // Nonactivating posture: never grab key focus on show, never hide
            // when the owning app deactivates, and sit across spaces as a
            // stationary auxiliary window.
            ns_window.setHidesOnDeactivate(false);
            ns_window.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
        }
    });
}

/// Order the window front WITHOUT activating the app or making the window key.
/// `WebviewWindow::show()` can route through a key/activate path on some Tauri
/// versions; `orderFrontRegardless` is the AppKit-level "show but don't steal
/// focus" call. We still call `show()` first so Tauri's visibility bookkeeping
/// stays consistent, then immediately order-front-regardless on the main thread.
#[cfg(target_os = "macos")]
fn order_front_nonactivating(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let win = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::NSWindow;
        if let Ok(ptr) = win.ns_window() {
            let ptr = ptr as *mut NSWindow;
            if !ptr.is_null() {
                // Safety: live NSWindow, main thread.
                unsafe {
                    (*ptr).orderFrontRegardless();
                }
            }
        }
    });
}

/// Size and top-center anchor the dock window on the PRIMARY monitor.
///
/// AppKit screen frames and window content sizes are both logical points, so
/// the complete geometry is applied directly in that unit. This avoids the
/// scale-aware Tauri resize path that can re-convert an overlay straddling 2x
/// and 1x displays. The desired height comes from state rather than the current
/// physical frame, making repeated monitor events idempotent.
#[cfg(target_os = "macos")]
fn resize_and_reposition(window: &tauri::WebviewWindow) {
    let win = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSScreen;

        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let screens = NSScreen::screens(mtm);
        let Some(primary) = screens.firstObject() else {
            return;
        };
        let primary_rect = primary.frame();
        let primary_top = primary_rect.origin.y + primary_rect.size.height;
        let logical_screens = screens
            .iter()
            .enumerate()
            .map(|(index, screen)| {
                let rect = screen.frame();
                let backing = screen.convertRectToBacking(objc2_foundation::NSRect::new(
                    objc2_foundation::NSPoint::new(0.0, 0.0),
                    objc2_foundation::NSSize::new(1.0, 1.0),
                ));
                crate::overlay_geometry::LogicalScreen {
                    x: rect.origin.x,
                    y: primary_top - (rect.origin.y + rect.size.height),
                    width: rect.size.width,
                    height: rect.size.height,
                    scale_factor: backing.size.width,
                    is_primary: index == 0,
                }
            })
            .collect::<Vec<_>>();
        let notch = primary.safeAreaInsets().top;
        let gap = if notch > 0.0 { 4.0 } else { 0.0 };
        let height = if EXPANDED.load(std::sync::atomic::Ordering::Acquire) {
            DOCK_EXPANDED_HEIGHT
        } else {
            DOCK_HEIGHT
        };
        let Some(frame) = crate::overlay_geometry::primary_top_center(
            &logical_screens,
            DOCK_WIDTH,
            height,
            DOCK_TOP_INSET + notch + gap,
        ) else {
            return;
        };
        if !crate::overlay_geometry::set_frame_points(&win, frame, primary_top) {
            log::warn!("[dock-window] failed to apply native point geometry");
        }
    });
}

// ── Non-macOS no-ops ──
#[cfg(not(target_os = "macos"))]
pub fn create(_app: &tauri::AppHandle, _api_port: u16) {}
#[cfg(not(target_os = "macos"))]
pub fn set_hit_rect(_x: f64, _y: f64, _w: f64, _h: f64) {}
#[cfg(not(target_os = "macos"))]
pub fn show(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn set_expanded(_app: &tauri::AppHandle, _expanded: bool) {}
#[cfg(not(target_os = "macos"))]
pub fn hide(_app: &tauri::AppHandle) {}
