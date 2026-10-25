//! Screen context for the Symon agent lane (Clicky-parity dossier #2).
//!
//! When the user's prompt references the screen ("what's this error", "where
//! do I click"), capture the monitor under the cursor and attach it to the
//! Gemini request as `inline_data`, so the ONE Option gesture handles guidance
//! questions too. Capture is INTENT-GATED — no screenshot leaves the machine
//! unless the prompt asks about the screen (privacy + tokens).
//!
//! No image crates: `screencapture` (capture) + `sips` (downscale) + a manual
//! PNG IHDR parse for dimensions. Both ship with macOS. First capture triggers
//! the one-time Screen Recording permission prompt for o8 — expected UX for
//! this feature class; without the grant macOS yields wallpaper-only frames.
//!
//! The recorded geometry (image px + monitor logical bounds) is what
//! `point_overlay::show_points` uses to map the model's `[POINT:x,y:...]`
//! screenshot-pixel coords back onto the screen.

use base64::Engine;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Fire the Screen Recording registration/prompt AFTER a failed capture.
/// Attempt-first on purpose: `CGPreflightScreenCaptureAccess` is unreliable on
/// recent macOS (observed returning false after a grant rebind even post-
/// relaunch), so the capture attempt itself is the truth — this only makes
/// sure o8 is registered in System Settings → Privacy & Security → Screen &
/// System Audio Recording so the user has something to toggle.
fn request_screen_permission() {
    // Safety: stateless CoreGraphics permission queries.
    unsafe {
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess();
        }
    }
}

/// Everything the request builder and the pointer transform need from one
/// capture: the image itself plus the monitor's logical geometry.
#[derive(Clone)]
pub struct ScreenContext {
    pub trace_id: u64,
    pub png_base64: String,
    /// Screenshot dimensions in IMAGE pixels (post-downscale).
    pub img_w: u32,
    pub img_h: u32,
    /// Captured monitor's bounds in global LOGICAL points (Tauri top-left origin).
    pub mon_x: f64,
    pub mon_y: f64,
    pub mon_w: f64,
    pub mon_h: f64,
    /// Exact native controls visible in the focused window at capture time.
    pub ax_catalog: Vec<crate::screen_localization::ActionableElement>,
    /// Exact DOM controls visible inside o8's browser surfaces.
    pub web_catalog: Vec<super::web_localization::WebActionableElement>,
}

/// Downscale ceiling — 1440px wide keeps UI text legible to the model while
/// bounding the image at ~1-2k Gemini tokens.
const MAX_IMG_WIDTH: u32 = 1440;

/// Conservative cue list: every entry implies the user is talking ABOUT the
/// screen. Bare "where" is deliberately absent ("where is my meeting" must not
/// trigger a capture).
const SCREEN_CUES: &[&str] = &[
    "on my screen",
    "on the screen",
    "on screen",
    "my screen",
    "this screen",
    "see my screen",
    "can you see",
    "do you see",
    "what's this",
    "what is this",
    "what am i looking at",
    "looking at",
    "this error",
    "this warning",
    "this dialog",
    "this window",
    "this page",
    "this button",
    "this menu",
    "this app",
    "this setting",
    "where do i click",
    "where do i go",
    "where is the",
    "where's the",
    "point to",
    "point at",
    "point out",
    "show me where",
    "walk me through",
    "what does this say",
    "read this",
    // Draw / teach intents. These MUST capture the screen — not because the
    // model needs to read it, but because the overlay needs a coordinate system
    // (image dims + monitor geometry) to place [DRAW]/[POINT] tags, and the draw
    // protocol is only taught to the model when a ScreenContext rides the turn.
    // Without a capture here the model has no way to draw and falls back to
    // writing an HTML file. Bias toward capturing: easy drawing outweighs the
    // rare wasted screenshot on a non-visual "teach me" (honesty-guarded).
    "draw",
    "illustrate",
    "illustration",
    "sketch",
    "diagram",
    "teach me",
    "annotate",
];

/// Should this prompt get a screenshot? Lowercased substring match against the
/// cue list — cheap, conservative, errs toward NOT capturing.
pub fn wants_screen(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    SCREEN_CUES.iter().any(|cue| p.contains(cue))
}

/// Capture the monitor under the cursor (fallback: primary). Blocking
/// (~300-600ms of subprocess) — call it from the agent worker thread before
/// the loop starts, never from the main thread.
pub fn capture(app: &tauri::AppHandle) -> Option<ScreenContext> {
    let monitors = app.available_monitors().ok()?;
    if monitors.is_empty() {
        return None;
    }
    let cursor = app.cursor_position().ok();
    let monitor = cursor
        .and_then(|c| {
            monitors
                .iter()
                .find(|m| {
                    let p = m.position();
                    let s = m.size();
                    c.x >= p.x as f64
                        && c.x < (p.x + s.width as i32) as f64
                        && c.y >= p.y as f64
                        && c.y < (p.y + s.height as i32) as f64
                })
                .cloned()
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned())?;
    let trace_id = crate::screen_localization::next_trace_id();
    let capture_started = std::time::Instant::now();
    let scale = monitor.scale_factor();
    let monitor_frame = (
        monitor.position().x as f64 / scale,
        monitor.position().y as f64 / scale,
        monitor.size().width as f64 / scale,
        monitor.size().height as f64 / scale,
    );
    let ax_catalog = crate::screen_localization::catalog_in_background(monitor_frame);

    // screencapture writes display 1 → first file, display 2 → second, in
    // CGDisplay order. That order isn't guaranteed to match Tauri's monitor
    // list, so capture ALL displays and pick the file whose pixel dimensions
    // match the target monitor (physical px == screenshot px). Identical twin
    // monitors would tie — first match wins (v1 limitation).
    let tmp = std::env::temp_dir();
    let stamp = std::process::id();
    let files: Vec<std::path::PathBuf> = (0..monitors.len())
        .map(|i| tmp.join(format!("o8-screen-{stamp}-{i}.png")))
        .collect();

    let mut cmd = crate::child_environment::command("screencapture");
    cmd.arg("-x"); // no shutter sound
    for f in &files {
        cmd.arg(f);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        let catalog = ax_catalog
            .join()
            .unwrap_or_else(|_| crate::screen_localization::CatalogSnapshot::thread_failed());
        log::warn!(
            "[symon-localization] {}",
            serde_json::json!({
                "stage": "capture", "trace": trace_id, "source": "screen",
                "status": "screen_capture_failed",
                "totalMs": capture_started.elapsed().as_millis() as u64,
                "axMs": catalog.elapsed_ms, "catalogCount": catalog.elements.len(),
            })
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!(
            "[symon-screen] screencapture exited with {}: {} — if this is a \
             permission denial, grant o8 under System Settings → Privacy & \
             Security → Screen & System Audio Recording and relaunch",
            output.status,
            stderr.trim()
        );
        request_screen_permission();
        cleanup(&files);
        return None;
    }

    let want_w = monitor.size().width;
    let want_h = monitor.size().height;
    let picked = files
        .iter()
        .find(|f| png_dimensions(f).is_some_and(|(w, h)| w == want_w && h == want_h))
        .or_else(|| files.iter().find(|f| f.exists()))
        .cloned();
    let Some(path) = picked else {
        cleanup(&files);
        return None;
    };

    // Downscale in place if wider than the ceiling (sips preserves aspect).
    if png_dimensions(&path).is_some_and(|(w, _)| w > MAX_IMG_WIDTH) {
        let _ = crate::child_environment::command("sips")
            .arg("--resampleWidth")
            .arg(MAX_IMG_WIDTH.to_string())
            .arg(&path)
            .output();
    }

    let (img_w, img_h) = png_dimensions(&path)?;
    let bytes = std::fs::read(&path).ok()?;
    cleanup(&files);

    let catalog = ax_catalog
        .join()
        .unwrap_or_else(|_| crate::screen_localization::CatalogSnapshot::thread_failed());
    log::info!(
        "[symon-localization] {}",
        serde_json::json!({
            "stage": "capture",
            "trace": trace_id,
            "source": "screen",
            "status": catalog.status,
            "totalMs": capture_started.elapsed().as_millis() as u64,
            "axMs": catalog.elapsed_ms,
            "visited": catalog.visited,
            "candidates": catalog.candidates,
            "catalogCount": catalog.elements.len(),
            "imageWidth": img_w,
            "imageHeight": img_h,
        })
    );
    let ctx = ScreenContext {
        trace_id,
        png_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        img_w,
        img_h,
        mon_x: monitor_frame.0,
        mon_y: monitor_frame.1,
        mon_w: monitor_frame.2,
        mon_h: monitor_frame.3,
        ax_catalog: catalog.elements,
        web_catalog: Vec::new(),
    };
    log::info!(
        "[symon-screen] captured {}x{} px ({} KB) of monitor at {},{} ({}x{} pt), {} native element(s)",
        ctx.img_w,
        ctx.img_h,
        bytes.len() / 1024,
        ctx.mon_x,
        ctx.mon_y,
        ctx.mon_w,
        ctx.mon_h,
        ctx.ax_catalog.len()
    );
    Some(ctx)
}

/// Capture ONLY the o8 window (not the whole desktop) as a base64 PNG, for the
/// in-app feedback / error report (operator note, 2026-06-16). Region capture
/// via `screencapture -R` over the window's logical bounds keeps unrelated apps
/// out of a report; the operator can still remove the shot before sending.
/// Downscaled to MAX_IMG_WIDTH so a retina window stays under Discord's webhook
/// ceiling. Blocking subprocess — Tauri runs commands off the main thread, so
/// this is safe to call directly from the command. None on any failure → the
/// feedback flow falls back to a manual paste.
pub fn capture_window(app: &tauri::AppHandle, label: &str) -> Option<String> {
    use tauri::Manager;
    let window = app.get_webview_window(label)?;
    let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
    let pos = window.outer_position().ok()?; // physical px, Tauri top-left origin
    let size = window.outer_size().ok()?;
    // `screencapture -R x,y,w,h` takes POINTS in the global display space (main
    // display top-left origin, y down) — same origin Tauri reports, so dividing
    // physical px by the scale factor yields the region to grab.
    let x = pos.x as f64 / scale;
    let y = pos.y as f64 / scale;
    let w = size.width as f64 / scale;
    let h = size.height as f64 / scale;
    if w < 1.0 || h < 1.0 {
        return None;
    }

    let path = std::env::temp_dir().join(format!("o8-feedback-{}.png", std::process::id()));
    let output = crate::child_environment::command("screencapture")
        .arg("-x") // no shutter sound
        .arg(format!("-R{x:.0},{y:.0},{w:.0},{h:.0}"))
        .arg(&path)
        .output()
        .ok()?;
    if !output.status.success() {
        log::warn!(
            "[feedback-capture] screencapture failed ({}): {} — grant o8 Screen \
             Recording in System Settings if this is a permission denial",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        request_screen_permission();
        let _ = std::fs::remove_file(&path);
        return None;
    }

    if png_dimensions(&path).is_some_and(|(w, _)| w > MAX_IMG_WIDTH) {
        let _ = crate::child_environment::command("sips")
            .arg("--resampleWidth")
            .arg(MAX_IMG_WIDTH.to_string())
            .arg(&path)
            .output();
    }

    let bytes = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    if bytes.is_empty() {
        return None;
    }
    Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

fn cleanup(files: &[std::path::PathBuf]) {
    for f in files {
        let _ = std::fs::remove_file(f);
    }
}

// ─────────────────────────── Spatial Context ───────────────────────────
//
// Symon Spatial Context: while holding Right-Option the operator can draw
// glowing strokes anywhere on the live screen. `capture_full` grabs the marked
// monitor at (near-)full resolution BEFORE the ink renders (fired on the FIRST
// stroke), and `composite_strokes` later burns the operator's normalized
// strokes into that screenshot and cuts a full-res crop of the marked region.
// Both images ride the same multimodal brain turn as the spoken command, so
// "why does THIS look off?" + a circle tells the model exactly where to look.
//
// Reuses the same macOS-native `screencapture` + `sips` + IHDR-parse toolchain
// as `capture`; the strokes are rasterized with the pure-Rust `image` crate.

/// Higher capture ceiling for spatial context than the plain `capture`
/// downscale (1440): the CROP of the marked region needs detail. Still bounded
/// so `image` decode + composite stays fast on a Retina panel.
const SPATIAL_CAPTURE_MAX_WIDTH: u32 = 2560;
/// The full-screen composite (with strokes burned in) is downscaled to this max
/// dimension — the "here's the whole screen and where I marked" image. ~1568 is
/// the sweet spot models attend to without burning tokens.
const SPATIAL_COMPOSITE_MAX: u32 = 1568;
/// The close-up crop is capped at this max dimension too (models attend far
/// better to a crop, but an un-bounded 4K region would be wasteful).
const SPATIAL_CROP_MAX: u32 = 1568;

/// A raw, undownscaled-to-composite screen grab kept around between the first
/// stroke and finalize so strokes can be burned into it after the fact.
pub struct RawCapture {
    pub trace_id: u64,
    pub png_bytes: Vec<u8>,
    pub mon_x: f64,
    pub mon_y: f64,
    pub mon_w: f64,
    pub mon_h: f64,
    pub ax_catalog: Vec<crate::screen_localization::ActionableElement>,
}

/// The two images a spatial turn carries: `screen` is the full-screen composite
/// (strokes burned in) — it doubles as the `ScreenContext` that maps any
/// `[POINT:...]` reply back onto the screen; `crop_png_base64` is the full-res
/// close-up of the marked region (None if the crop couldn't be cut).
pub struct SpatialContext {
    pub screen: ScreenContext,
    pub crop_png_base64: Option<String>,
}

/// Capture the monitor under the cursor at up to `SPATIAL_CAPTURE_MAX_WIDTH`,
/// returning the raw PNG bytes + geometry (NOT base64 — the strokes get burned
/// in first). Blocking subprocess; call off the main thread. Mirrors `capture`'s
/// multi-display pick, but keeps more resolution for the crop.
pub fn capture_full(
    app: &tauri::AppHandle,
    marked_monitor: Option<tauri::Monitor>,
) -> Option<RawCapture> {
    let monitors = app.available_monitors().ok()?;
    if monitors.is_empty() {
        return None;
    }
    let cursor = app.cursor_position().ok();
    let monitor = marked_monitor.or_else(|| {
        cursor
            .and_then(|c| {
                monitors
                    .iter()
                    .find(|m| {
                        let p = m.position();
                        let s = m.size();
                        c.x >= p.x as f64
                            && c.x < (p.x + s.width as i32) as f64
                            && c.y >= p.y as f64
                            && c.y < (p.y + s.height as i32) as f64
                    })
                    .cloned()
            })
            .or_else(|| app.primary_monitor().ok().flatten())
            .or_else(|| monitors.first().cloned())
    })?;
    let trace_id = crate::screen_localization::next_trace_id();
    let capture_started = std::time::Instant::now();
    let scale = monitor.scale_factor();
    let monitor_frame = (
        monitor.position().x as f64 / scale,
        monitor.position().y as f64 / scale,
        monitor.size().width as f64 / scale,
        monitor.size().height as f64 / scale,
    );
    let ax_catalog = crate::screen_localization::catalog_in_background(monitor_frame);

    let tmp = std::env::temp_dir();
    let stamp = std::process::id();
    let files: Vec<std::path::PathBuf> = (0..monitors.len())
        .map(|i| tmp.join(format!("o8-spatial-{stamp}-{trace_id}-{i}.png")))
        .collect();

    let mut cmd = crate::child_environment::command("screencapture");
    cmd.arg("-x");
    for f in &files {
        cmd.arg(f);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        let catalog = ax_catalog
            .join()
            .unwrap_or_else(|_| crate::screen_localization::CatalogSnapshot::thread_failed());
        log::warn!(
            "[symon-localization] {}",
            serde_json::json!({
                "stage": "capture", "trace": trace_id, "source": "spatial",
                "status": "screen_capture_failed",
                "totalMs": capture_started.elapsed().as_millis() as u64,
                "axMs": catalog.elapsed_ms, "catalogCount": catalog.elements.len(),
            })
        );
        log::warn!(
            "[spatial-context] screencapture failed ({}): {} — grant o8 Screen \
             Recording in System Settings if this is a permission denial",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        request_screen_permission();
        cleanup(&files);
        return None;
    }

    let want_w = monitor.size().width;
    let want_h = monitor.size().height;
    let picked = files
        .iter()
        .find(|f| png_dimensions(f).is_some_and(|(w, h)| w == want_w && h == want_h))
        .or_else(|| files.iter().find(|f| f.exists()))
        .cloned();
    let Some(path) = picked else {
        cleanup(&files);
        return None;
    };

    if png_dimensions(&path).is_some_and(|(w, _)| w > SPATIAL_CAPTURE_MAX_WIDTH) {
        let _ = crate::child_environment::command("sips")
            .arg("--resampleWidth")
            .arg(SPATIAL_CAPTURE_MAX_WIDTH.to_string())
            .arg(&path)
            .output();
    }

    let (img_w, img_h) = png_dimensions(&path)?;
    let bytes = std::fs::read(&path).ok()?;
    cleanup(&files);

    let catalog = ax_catalog
        .join()
        .unwrap_or_else(|_| crate::screen_localization::CatalogSnapshot::thread_failed());
    log::info!(
        "[symon-localization] {}",
        serde_json::json!({
            "stage": "capture",
            "trace": trace_id,
            "source": "spatial",
            "status": catalog.status,
            "totalMs": capture_started.elapsed().as_millis() as u64,
            "axMs": catalog.elapsed_ms,
            "visited": catalog.visited,
            "candidates": catalog.candidates,
            "catalogCount": catalog.elements.len(),
            "imageWidth": img_w,
            "imageHeight": img_h,
        })
    );
    log::info!(
        "[spatial-context] captured {}x{} px ({} KB) of monitor at {},{}",
        img_w,
        img_h,
        bytes.len() / 1024,
        monitor_frame.0,
        monitor_frame.1
    );
    Some(RawCapture {
        trace_id,
        png_bytes: bytes,
        mon_x: monitor_frame.0,
        mon_y: monitor_frame.1,
        mon_w: monitor_frame.2,
        mon_h: monitor_frame.3,
        ax_catalog: catalog.elements,
    })
}

/// Burn the operator's strokes into `raw` and produce the two spatial images.
/// `strokes` is a list of polylines, each a `Vec` of NORMALIZED (0..1) points in
/// the marked monitor's coordinate space (the ink page reports them normalized
/// so they survive the capture-vs-window resolution mismatch). Returns None if
/// there are no drawable points or the screenshot can't be decoded.
pub fn composite_strokes(raw: &RawCapture, strokes: &[Vec<(f64, f64)>]) -> Option<SpatialContext> {
    use image::imageops::FilterType;
    use image::RgbaImage;

    let stroke_count = strokes.iter().filter(|s| !s.is_empty()).count();
    if stroke_count == 0 {
        return None;
    }

    let mut img: RgbaImage = image::load_from_memory(&raw.png_bytes).ok()?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return None;
    }
    let wf = w as f64;
    let hf = h as f64;

    // Stroke geometry in pixels + the union bounding box (for the crop).
    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    let mut px_strokes: Vec<Vec<(f64, f64)>> = Vec::with_capacity(strokes.len());
    for stroke in strokes {
        if stroke.is_empty() {
            continue;
        }
        let mut pts = Vec::with_capacity(stroke.len());
        for &(nx, ny) in stroke {
            let px = (nx.clamp(0.0, 1.0)) * wf;
            let py = (ny.clamp(0.0, 1.0)) * hf;
            min_x = min_x.min(px);
            min_y = min_y.min(py);
            max_x = max_x.max(px);
            max_y = max_y.max(py);
            pts.push((px, py));
        }
        px_strokes.push(pts);
    }
    if max_x < min_x || max_y < min_y {
        return None;
    }

    // Crop the CLEAN screenshot (no strokes) so the close-up shows unobstructed
    // content — the composite already shows WHERE the mark is. +15% margin,
    // floored to a minimum region so a single tap still yields a useful crop.
    let crop_png_base64 = cut_crop(&img, min_x, min_y, max_x, max_y, wf, hf);

    // Ember-orange (#FF5A1F) core with a lighter rim, both opaque so a dense
    // polyline never over-accumulates alpha. Radius scales with resolution.
    let core_r = (wf / 300.0).clamp(5.0, 14.0);
    let halo_r = core_r * 1.9;
    const CORE: [u8; 4] = [0xFF, 0x5A, 0x1F, 0xFF];
    const HALO: [u8; 4] = [0xFF, 0x8A, 0x4A, 0xFF];
    for pts in &px_strokes {
        draw_polyline(&mut img, pts, halo_r, HALO);
    }
    for pts in &px_strokes {
        draw_polyline(&mut img, pts, core_r, CORE);
    }

    // Downscale the stroked composite to the token-friendly ceiling.
    let longest = w.max(h);
    let composite = if longest > SPATIAL_COMPOSITE_MAX {
        let s = SPATIAL_COMPOSITE_MAX as f64 / longest as f64;
        let nw = ((w as f64 * s).round() as u32).max(1);
        let nh = ((h as f64 * s).round() as u32).max(1);
        image::imageops::resize(&img, nw, nh, FilterType::Triangle)
    } else {
        img
    };
    let (cw, ch) = (composite.width(), composite.height());
    let png = encode_png(&composite)?;

    let screen = ScreenContext {
        trace_id: raw.trace_id,
        png_base64: base64::engine::general_purpose::STANDARD.encode(&png),
        img_w: cw,
        img_h: ch,
        mon_x: raw.mon_x,
        mon_y: raw.mon_y,
        mon_w: raw.mon_w,
        mon_h: raw.mon_h,
        ax_catalog: raw.ax_catalog.clone(),
        web_catalog: Vec::new(),
    };
    log::info!(
        "[spatial-context] composited {stroke_count} stroke(s): composite {cw}x{ch}, crop={}",
        if crop_png_base64.is_some() {
            "yes"
        } else {
            "no"
        }
    );
    Some(SpatialContext {
        screen,
        crop_png_base64,
    })
}

/// Cut the +15%-margin crop of the marked region out of a CLEAN screenshot.
fn cut_crop(
    img: &image::RgbaImage,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    wf: f64,
    hf: f64,
) -> Option<String> {
    use image::imageops::FilterType;
    let span_x = (max_x - min_x).max(1.0);
    let span_y = (max_y - min_y).max(1.0);
    let margin_x = (span_x * 0.15).max(wf * 0.04);
    let margin_y = (span_y * 0.15).max(hf * 0.04);
    let x0 = (min_x - margin_x).clamp(0.0, wf);
    let y0 = (min_y - margin_y).clamp(0.0, hf);
    let x1 = (max_x + margin_x).clamp(0.0, wf);
    let y1 = (max_y + margin_y).clamp(0.0, hf);
    let cx = x0.floor() as u32;
    let cy = y0.floor() as u32;
    let cw = ((x1 - x0).ceil() as u32).clamp(1, img.width().saturating_sub(cx).max(1));
    let ch = ((y1 - y0).ceil() as u32).clamp(1, img.height().saturating_sub(cy).max(1));
    if cw < 2 || ch < 2 {
        return None;
    }
    let crop = image::imageops::crop_imm(img, cx, cy, cw, ch).to_image();
    let longest = cw.max(ch);
    let crop = if longest > SPATIAL_CROP_MAX {
        let s = SPATIAL_CROP_MAX as f64 / longest as f64;
        let nw = ((cw as f64 * s).round() as u32).max(1);
        let nh = ((ch as f64 * s).round() as u32).max(1);
        image::imageops::resize(&crop, nw, nh, FilterType::Triangle)
    } else {
        crop
    };
    let png = encode_png(&crop)?;
    Some(base64::engine::general_purpose::STANDARD.encode(&png))
}

/// Stamp a filled disc of round caps along a polyline (round joins for free).
fn draw_polyline(img: &mut image::RgbaImage, pts: &[(f64, f64)], r: f64, color: [u8; 4]) {
    if pts.is_empty() {
        return;
    }
    if pts.len() == 1 {
        stamp_disc(img, pts[0].0, pts[0].1, r, color);
        return;
    }
    for seg in pts.windows(2) {
        let (x0, y0) = seg[0];
        let (x1, y1) = seg[1];
        let dist = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
        let steps = ((dist / (r * 0.4)).ceil() as usize).max(1);
        for i in 0..=steps {
            let t = i as f64 / steps as f64;
            stamp_disc(img, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, color);
        }
    }
}

/// Paint one opaque filled disc at (cx,cy). Opaque so overlapping stamps along a
/// dense stroke never accumulate — the rim reads as a clean glow band.
fn stamp_disc(img: &mut image::RgbaImage, cx: f64, cy: f64, r: f64, color: [u8; 4]) {
    let w = img.width() as i64;
    let h = img.height() as i64;
    let r2 = r * r;
    let x0 = ((cx - r).floor() as i64).max(0);
    let x1 = ((cx + r).ceil() as i64).min(w - 1);
    let y0 = ((cy - r).floor() as i64).max(0);
    let y1 = ((cy + r).ceil() as i64).min(h - 1);
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = x as f64 + 0.5 - cx;
            let dy = y as f64 + 0.5 - cy;
            if dx * dx + dy * dy <= r2 {
                img.get_pixel_mut(x as u32, y as u32).0 = color;
            }
        }
    }
}

/// Encode an RgbaImage to PNG bytes without a DynamicImage clone.
fn encode_png(img: &image::RgbaImage) -> Option<Vec<u8>> {
    use image::codecs::png::PngEncoder;
    use image::ImageEncoder;
    let mut buf = Vec::new();
    PngEncoder::new(&mut buf)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .ok()?;
    Some(buf)
}

/// Width/height from the PNG IHDR chunk (bytes 16..24 after the 8-byte
/// signature + 4-byte length + "IHDR"). Avoids pulling an image crate for two
/// big-endian u32 reads.
fn png_dimensions(path: &std::path::Path) -> Option<(u32, u32)> {
    let mut buf = [0u8; 24];
    let mut file = std::fs::File::open(path).ok()?;
    std::io::Read::read_exact(&mut file, &mut buf).ok()?;
    if &buf[0..8] != b"\x89PNG\r\n\x1a\n" || &buf[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
    let h = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
    Some((w, h))
}

/// Which Gemini model reads the screen. Vision must hit Gemini (the Claude
/// text-planner can't see, and OpenRouter ids here aren't assumed multimodal),
/// so reuse the user's configured front-brain model when it IS a Gemini id, else
/// fall back to the proven default the front brain already sends screenshots to.
fn vision_model() -> String {
    let configured = super::router::load_config().mac_native_action;
    if !configured.contains('/') && configured.starts_with("gemini") {
        configured
    } else {
        crate::models::GEMINI_3_FLASH_PREVIEW.to_string()
    }
}

/// `read_screen` tool — give the (text-only) brain SIGHT. The Gemini front brain
/// already sees the screen inline, but the Claude background text-planner can't;
/// this routes a screenshot through `gemini::vision_extract` and returns the
/// extracted text to WHICHEVER brain called it (no MCP surface needed). Prefers
/// the screenshot already captured for this task (intent-gated), else grabs one
/// on demand. ReadOnly in `safety` — observation only; capture is permission-
/// gated by macOS Screen Recording.
pub async fn read_screen(
    ctx: &super::TaskCtx,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let focus = args
        .get("focus")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let png = if let Some(screen) = &ctx.screen {
        screen.png_base64.clone()
    } else {
        let app = ctx.app_handle()?.clone();
        let captured = tokio::task::spawn_blocking(move || capture(&app))
            .await
            .map_err(|e| format!("screen capture task failed: {e}"))?;
        match captured {
            Some(s) => s.png_base64,
            None => {
                return Err(
                    "I couldn't capture the screen — turn on Screen Recording for o8 in \
                            System Settings → Privacy & Security."
                        .to_string(),
                )
            }
        }
    };

    let prompt = match &focus {
        Some(f) => format!(
            "You are reading the user's Mac screen for a voice assistant. Focus on: {f}. \
             Answer concisely and spoken-ready (no markdown). If that isn't visible, say so."
        ),
        None => "You are reading the user's Mac screen for a voice assistant. Describe what's on \
                 screen — the active app/window and the key text or state the user would care \
                 about. Concise and spoken-ready (no markdown, a few sentences)."
            .to_string(),
    };

    let text = super::gemini::vision_extract(&vision_model(), &prompt, &png).await?;
    Ok(serde_json::json!({ "screen_text": text }))
}

#[cfg(test)]
#[path = "screen/wants_screen_tests.rs"]
mod wants_screen_tests;

#[cfg(test)]
#[path = "screen/composite_tests.rs"]
mod composite_tests;
