//! Symon Points — the screen pointing overlay (Clicky-parity dossier #1).
//!
//! A THIRD always-on-top transparent Tauri window — label **`point-overlay`**,
//! never `main`, never `dock`. Unlike the dock it is fully CLICK-THROUGH
//! (`set_ignore_cursor_events(true)`): it exists only to paint the animated
//! glass-dot pointer + label chips over the user's screen while Symon answers
//! "where is it?" questions, and must never eat a click.
//!
//! Protocol: the agent model emits `[POINT:x,y:label]` tags inline in its
//! reply text (LLM-native, no tool-call overhead — x,y in SCREENSHOT pixels).
//! `parse_point_tags` strips them from the spoken/displayed text;
//! `show_points` maps screenshot px → monitor-local logical points using the
//! `ScreenContext` geometry recorded at capture time, then positions this
//! window over the captured monitor and emits `o8:point-show` to the
//! `/point-overlay` route. The same three-axis transform class that bit the
//! webview MCP tools (#1105) — screenshot px vs display points vs Retina
//! scale — is centralized HERE, in one function, on purpose.
//!
//! Lifecycle: lazy-created on first use, then kept alive hidden (first paint
//! costs a Next route load; reuse is instant). A generation counter guards the
//! auto-hide timer so a newer show is never clobbered by an older timer.

#[cfg(target_os = "macos")]
pub const POINT_LABEL: &str = "point-overlay";

/// What a tag draws. `Point` is the original pointer dot (POINT/GUIDE);
/// `Rect`/`Arrow` are the "Symon Draws" annotations — a box around, or an arrow
/// to, a region — using the SAME screenshot→screen transform, applied to two
/// points instead of one.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Point,
    Rect,
    Arrow,
    /// Teaching mode (#1251): a freehand line segment (x,y)→(x2,y2) — triangle
    /// edges, axes, connectors. Drawn on blank space, so no AX snap.
    Line,
    /// Teaching mode (#1251): a text label / equation anchored at (x,y); the
    /// label IS the rendered text ("a", "a² + b² = c²"). Point-arity coords.
    Text,
}

/// One parsed tag, still in screenshot-pixel space. For `Point` only (x, y) are
/// meaningful; `Rect`/`Arrow` also use (x2, y2) as the opposite corner / arrow
/// head.
pub struct ParsedTag {
    /// Exact Accessibility-catalog target. When set, pixel coordinates are
    /// ignored and the overlay resolves the current captured element frame.
    pub element_id: Option<usize>,
    /// Exact DOM-catalog target inside o8's embedded browser.
    pub web_element_id: Option<usize>,
    pub x: f64,
    pub y: f64,
    /// Second point for Rect/Arrow (opposite corner / arrow head). Unused (0)
    /// for Point.
    pub x2: f64,
    pub y2: f64,
    pub label: String,
    /// GUIDE tags (magic roadmap #3): the marker lands and DWELLS pulsing
    /// until the user's cursor reaches it (or a long cap) instead of the
    /// 8s auto-fade — the un-lost button. Point-only.
    pub dwell: bool,
    pub shape: Shape,
}

/// Which family a recognized prefix belongs to.
#[derive(Clone, Copy)]
enum TagKind {
    Point { dwell: bool },
    Draw,
}

/// Parse and STRIP pixel tags plus exact catalog tags such as
/// `[POINT:el:12]`, `[GUIDE:el:12]`, and `[DRAW:el:12]` (each optionally
/// labelled). A trailing `screenN` is accepted and ignored in v1.
/// Returns the cleaned text (what gets spoken/stored) plus the tags in order.
/// Malformed tags are stripped but skipped — garbage never reaches TTS.
pub fn parse_point_tags(text: &str) -> (String, Vec<ParsedTag>) {
    const PREFIXES: [(&str, TagKind); 3] = [
        ("[POINT:", TagKind::Point { dwell: false }),
        ("[GUIDE:", TagKind::Point { dwell: true }),
        ("[DRAW:", TagKind::Draw),
    ];
    let mut clean = String::with_capacity(text.len());
    let mut tags: Vec<ParsedTag> = Vec::new();
    let mut rest = text;

    loop {
        // Earliest occurrence of any prefix wins.
        let found = PREFIXES
            .iter()
            .filter_map(|(p, kind)| rest.find(p).map(|i| (i, *p, *kind)))
            .min_by_key(|(i, _, _)| *i);
        let Some((start, prefix, kind)) = found else {
            break;
        };
        let (before, tail) = rest.split_at(start);
        clean.push_str(before);
        let Some(end) = tail.find(']') else {
            // Unterminated tag — keep the text as-is and stop scanning.
            clean.push_str(tail);
            rest = "";
            break;
        };
        let inner = &tail[prefix.len()..end];
        let parsed = match kind {
            TagKind::Point { dwell } => parse_point_inner(inner, dwell),
            TagKind::Draw => parse_draw_inner(inner),
        };
        if let Some(tag) = parsed {
            tags.push(tag);
        }
        rest = &tail[end + 1..];
    }
    clean.push_str(rest);

    // Tag removal can leave doubled spaces / dangling space-before-punct.
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    (clean, tags)
}

/// Render a parsed tag back to its canonical `[...]` source form. Used to feed
/// a prior drawing's tags back to the brain so it can re-emit them unchanged and
/// append new ones — the mechanism behind additive teaching diagrams (#1251).
/// Coords print as integers when whole (how the model emits them).
pub fn tag_to_string(t: &ParsedTag) -> String {
    let c = |v: f64| -> String {
        if v.fract() == 0.0 {
            format!("{}", v as i64)
        } else {
            format!("{v}")
        }
    };
    let exact_target = t
        .web_element_id
        .map(|id| ("web", id))
        .or_else(|| t.element_id.map(|id| ("el", id)));
    if let Some((kind, element_id)) = exact_target {
        let exact = match t.shape {
            Shape::Point if t.dwell => Some(format!("[GUIDE:{kind}:{element_id}:{}]", t.label)),
            Shape::Point => Some(format!("[POINT:{kind}:{element_id}:{}]", t.label)),
            Shape::Rect => Some(format!("[DRAW:{kind}:{element_id}:{}]", t.label)),
            _ => None,
        };
        if let Some(exact) = exact {
            return exact;
        }
    }
    match t.shape {
        Shape::Point if t.dwell => format!("[GUIDE:{},{}:{}]", c(t.x), c(t.y), t.label),
        Shape::Point => format!("[POINT:{},{}:{}]", c(t.x), c(t.y), t.label),
        Shape::Rect => format!("[DRAW:rect:{},{},{},{}:{}]", c(t.x), c(t.y), c(t.x2), c(t.y2), t.label),
        Shape::Arrow => format!("[DRAW:arrow:{},{},{},{}:{}]", c(t.x), c(t.y), c(t.x2), c(t.y2), t.label),
        Shape::Line => format!("[DRAW:line:{},{},{},{}:{}]", c(t.x), c(t.y), c(t.x2), c(t.y2), t.label),
        Shape::Text => format!("[DRAW:text:{},{}:{}]", c(t.x), c(t.y), t.label),
    }
}

/// Drop a trailing `screenN` qualifier from the segment list, in place.
fn strip_screen_suffix(segments: &mut Vec<&str>) {
    if segments.len() > 2 {
        if let Some(last) = segments.last() {
            let l = last.trim().to_ascii_lowercase();
            if l.strip_prefix("screen").is_some_and(|n| n.parse::<usize>().is_ok()) {
                segments.pop();
            }
        }
    }
}

/// `x,y:label` or `x,y:label:screenN` → a Point tag. Labels may contain ':'
/// (everything between the coords and a trailing screenN is the label).
fn parse_point_inner(inner: &str, dwell: bool) -> Option<ParsedTag> {
    let mut segments: Vec<&str> = inner.split(':').collect();
    if segments.len() < 2 {
        return None;
    }
    strip_screen_suffix(&mut segments);
    let target_kind = segments.first()?.trim().to_ascii_lowercase();
    if target_kind == "el" || target_kind == "web" {
        segments.remove(0);
        let element_id = segments.first()?.trim().parse::<usize>().ok()?;
        if element_id == 0 {
            return None;
        }
        segments.remove(0);
        return Some(ParsedTag {
            element_id: (target_kind == "el").then_some(element_id),
            web_element_id: (target_kind == "web").then_some(element_id),
            x: 0.0,
            y: 0.0,
            x2: 0.0,
            y2: 0.0,
            label: segments.join(":").trim().to_string(),
            dwell,
            shape: Shape::Point,
        });
    }
    let coords = segments.remove(0);
    let label = segments.join(":").trim().to_string();
    let (x_str, y_str) = coords.split_once(',')?;
    let x = x_str.trim().parse::<f64>().ok()?;
    let y = y_str.trim().parse::<f64>().ok()?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(ParsedTag {
        element_id: None,
        web_element_id: None,
        x,
        y,
        x2: 0.0,
        y2: 0.0,
        label,
        dwell,
        shape: Shape::Point,
    })
}

/// `rect|arrow:x1,y1,x2,y2:label` (optionally `...:screenN`) → a Rect/Arrow tag.
fn parse_draw_inner(inner: &str) -> Option<ParsedTag> {
    let mut segments: Vec<&str> = inner.split(':').collect();
    if segments.len() < 2 {
        return None;
    }
    strip_screen_suffix(&mut segments);
    let target_kind = segments.first()?.trim().to_ascii_lowercase();
    if target_kind == "el" || target_kind == "web" {
        segments.remove(0);
        let element_id = segments.first()?.trim().parse::<usize>().ok()?;
        if element_id == 0 {
            return None;
        }
        segments.remove(0);
        return Some(ParsedTag {
            element_id: (target_kind == "el").then_some(element_id),
            web_element_id: (target_kind == "web").then_some(element_id),
            x: 0.0,
            y: 0.0,
            x2: 0.0,
            y2: 0.0,
            label: segments.join(":").trim().to_string(),
            dwell: false,
            shape: Shape::Rect,
        });
    }
    let shape = match segments.remove(0).trim().to_ascii_lowercase().as_str() {
        "rect" | "box" | "rectangle" => Shape::Rect,
        "arrow" => Shape::Arrow,
        "line" => Shape::Line,
        "text" | "label" => Shape::Text,
        _ => return None,
    };
    let coords = segments.remove(0);
    let label = segments.join(":").trim().to_string();
    let nums: Vec<f64> = coords
        .split(',')
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .collect();
    // Text anchors at ONE point and the label is the rendered string; rect /
    // arrow / line take TWO points.
    if shape == Shape::Text {
        if nums.len() != 2 || !nums.iter().all(|n| n.is_finite()) || label.is_empty() {
            return None;
        }
        return Some(ParsedTag {
            element_id: None,
            web_element_id: None,
            x: nums[0],
            y: nums[1],
            x2: 0.0,
            y2: 0.0,
            label,
            dwell: false,
            shape,
        });
    }
    if nums.len() != 4 || !nums.iter().all(|n| n.is_finite()) {
        return None;
    }
    Some(ParsedTag {
        element_id: None,
        web_element_id: None,
        x: nums[0],
        y: nums[1],
        x2: nums[2],
        y2: nums[3],
        label,
        dwell: false,
        shape,
    })
}

#[cfg(test)]
#[path = "point_overlay/parse_tests.rs"]
mod parse_tests;


// ── macOS implementation ─────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod overlay {
    use super::{ParsedTag, Shape};
    use crate::agent::screen::ScreenContext;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;
    use tauri::{Emitter, Manager};

    /// Resolved frontend port, stashed at setup so the lazily-created overlay
    /// window can build its URL (mirrors how dock_window gets `api_port`).
    static API_PORT: OnceLock<u16> = OnceLock::new();

    /// Show-generation guard: each `show_points` bumps this; the auto-hide
    /// timer only fires if its generation is still current.
    static GENERATION: AtomicU64 = AtomicU64::new(0);

    pub fn init(api_port: u16) {
        let _ = API_PORT.set(api_port);
    }

    /// Snap a guessed global screen point to the real AX element under it,
    /// returned as `(x, y, w, h)` in MONITOR-LOCAL logical points. `None` when
    /// Accessibility can't resolve a usable element or the hit is implausible
    /// (covers >55% of the monitor = a window/group, not a control; or is
    /// degenerate) — the caller then keeps the model's vision-estimated pixel.
    /// This is what makes Symon's box land ON the button instead of near it.
    fn ax_snap_frame(screen: &ScreenContext, gx: f64, gy: f64) -> Option<(f64, f64, f64, f64)> {
        let (fx, fy, fw, fh) =
            crate::screen_localization::actionable_frame_at_point(gx, gy)?;
        if fw < 8.0 || fh < 8.0 || fw * fh > 0.55 * screen.mon_w * screen.mon_h {
            return None;
        }
        let lx = (fx - screen.mon_x).clamp(0.0, screen.mon_w);
        let ly = (fy - screen.mon_y).clamp(0.0, screen.mon_h);
        let lw = fw.min(screen.mon_w - lx);
        let lh = fh.min(screen.mon_h - ly);
        Some((lx, ly, lw, lh))
    }

    fn catalog_frame(
        screen: &ScreenContext,
        element_id: usize,
    ) -> Option<((f64, f64, f64, f64), &str)> {
        let element = screen.ax_catalog.iter().find(|item| item.id == element_id)?;
        let (fx, fy, fw, fh) = element.frame;
        let lx = (fx - screen.mon_x).clamp(0.0, screen.mon_w);
        let ly = (fy - screen.mon_y).clamp(0.0, screen.mon_h);
        let lw = fw.min(screen.mon_w - lx);
        let lh = fh.min(screen.mon_h - ly);
        (lw >= 8.0 && lh >= 8.0).then_some(((lx, ly, lw, lh), element.label.as_str()))
    }

    fn web_catalog_frame(
        screen: &ScreenContext,
        element_id: usize,
    ) -> Option<((f64, f64, f64, f64), &str)> {
        let element = screen.web_catalog.iter().find(|item| item.id == element_id)?;
        let (fx, fy, fw, fh) = element.frame;
        let lx = (fx - screen.mon_x).clamp(0.0, screen.mon_w);
        let ly = (fy - screen.mon_y).clamp(0.0, screen.mon_h);
        let lw = fw.min(screen.mon_w - lx);
        let lh = fh.min(screen.mon_h - ly);
        (lw >= 4.0 && lh >= 4.0).then_some(((lx, ly, lw, lh), element.label.as_str()))
    }

    #[derive(Default)]
    struct ResolutionStats {
        exact_resolved: usize,
        native_exact_resolved: usize,
        web_exact_resolved: usize,
        ax_snapped: usize,
        direct_pixel: usize,
        stale: usize,
    }

    fn resolve_points(
        screen: &ScreenContext,
        tags: &[ParsedTag],
    ) -> (Vec<serde_json::Value>, ResolutionStats) {
        let map_x = |v: f64| (v / screen.img_w as f64 * screen.mon_w).clamp(0.0, screen.mon_w);
        let map_y = |v: f64| (v / screen.img_h as f64 * screen.mon_h).clamp(0.0, screen.mon_h);
        let to_global = |lx: f64, ly: f64| (screen.mon_x + lx, screen.mon_y + ly);
        let center = |(x, y, w, h): (f64, f64, f64, f64)| (x + w / 2.0, y + h / 2.0);
        let mut stats = ResolutionStats::default();
        let points = tags
            .iter()
            .filter_map(|t| {
                let native_exact = t.element_id.and_then(|id| catalog_frame(screen, id));
                let web_exact = t.web_element_id.and_then(|id| web_catalog_frame(screen, id));
                let exact = native_exact.or(web_exact);
                if (t.element_id.is_some() || t.web_element_id.is_some()) && exact.is_none() {
                    stats.stale += 1;
                    return None;
                }
                if exact.is_some() {
                    stats.exact_resolved += 1;
                    stats.native_exact_resolved += usize::from(native_exact.is_some());
                    stats.web_exact_resolved += usize::from(web_exact.is_some());
                }
                let label = if t.label.is_empty() {
                    exact.map(|(_, label)| label).unwrap_or_default()
                } else {
                    t.label.as_str()
                };
                let x = map_x(t.x);
                let y = map_y(t.y);
                let point = match t.shape {
                    Shape::Point => {
                        let (px, py) = match exact {
                            Some((frame, _)) => center(frame),
                            None => {
                                let (gx, gy) = to_global(x, y);
                                match ax_snap_frame(screen, gx, gy).map(center) {
                                    Some(snapped) => {
                                        stats.ax_snapped += 1;
                                        snapped
                                    }
                                    None => {
                                        stats.direct_pixel += 1;
                                        (x, y)
                                    }
                                }
                            }
                        };
                        json!({ "shape": "point", "x": px, "y": py, "label": label, "dwell": t.dwell })
                    }
                    Shape::Rect => {
                        let (x2, y2) = (map_x(t.x2), map_y(t.y2));
                        let snapped = exact.map(|(frame, _)| frame).or_else(|| {
                            let (gcx, gcy) = to_global((x + x2) / 2.0, (y + y2) / 2.0);
                            ax_snap_frame(screen, gcx, gcy)
                        });
                        match snapped {
                            Some((lx, ly, lw, lh)) => {
                                if exact.is_none() {
                                    stats.ax_snapped += 1;
                                }
                                json!({
                                    "shape": "rect", "x": lx, "y": ly,
                                    "x2": lx + lw, "y2": ly + lh, "label": label
                                })
                            }
                            None => {
                                stats.direct_pixel += 1;
                                json!({
                                    "shape": "rect", "x": x, "y": y,
                                    "x2": x2, "y2": y2, "label": label
                                })
                            }
                        }
                    }
                    Shape::Arrow => {
                        let (x2, y2) = (map_x(t.x2), map_y(t.y2));
                        let (ghx, ghy) = to_global(x2, y2);
                        let (hx, hy) = match ax_snap_frame(screen, ghx, ghy).map(center) {
                            Some(snapped) => {
                                stats.ax_snapped += 1;
                                snapped
                            }
                            None => {
                                stats.direct_pixel += 1;
                                (x2, y2)
                            }
                        };
                        json!({ "shape": "arrow", "x": x, "y": y, "x2": hx, "y2": hy, "label": label })
                    }
                    Shape::Line => {
                        stats.direct_pixel += 1;
                        json!({
                            "shape": "line", "x": x, "y": y,
                            "x2": map_x(t.x2), "y2": map_y(t.y2), "label": label
                        })
                    }
                    Shape::Text => {
                        stats.direct_pixel += 1;
                        json!({ "shape": "text", "x": x, "y": y, "label": label })
                    }
                };
                Some(point)
            })
            .collect();
        (points, stats)
    }

    /// Map screenshot-pixel tags onto the captured monitor and animate them.
    /// Fire-and-forget: spawns a worker thread that ensures the window (first
    /// use pays a route-load wait), emits `o8:point-show`, then auto-hides.
    pub fn show_points(app: &tauri::AppHandle, screen: &ScreenContext, tags: &[ParsedTag]) {
        if tags.is_empty() {
            return;
        }
        // #2147 — quiet mode owns overlay visibility for its duration.
        if crate::presentation::overlay_show_blocked() {
            return;
        }
        let (points, stats) = resolve_points(screen, tags);
        log::info!(
            "[symon-localization] {}",
            serde_json::json!({
                "stage": "overlay",
                "trace": screen.trace_id,
                "tagCount": tags.len(),
                "outputCount": points.len(),
                "exactResolved": stats.exact_resolved,
                "nativeExactResolved": stats.native_exact_resolved,
                "webExactResolved": stats.web_exact_resolved,
                "axSnapped": stats.ax_snapped,
                "directPixel": stats.direct_pixel,
                "stale": stats.stale,
            })
        );
        if points.is_empty() {
            return;
        }
        // GUIDE targets in window-local logical px — the proximity watcher
        // compares the live cursor against these instead of a fixed timer.
        let dwell_targets: Vec<(f64, f64)> = points
            .iter()
            .filter(|p| p["dwell"].as_bool() == Some(true))
            .map(|p| (p["x"].as_f64().unwrap_or(0.0), p["y"].as_f64().unwrap_or(0.0)))
            .collect();

        let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let count = points.len();
        // A teaching diagram (freehand line/text) must persist across the back-
        // and-forth of a lesson — each "go deeper" turn supersedes it and resets
        // this timer, so 2 min keeps the picture up between turns (#1251). GUIDE
        // dwells until the user acts (90s). Plain point/box tours fade fast.
        let teaching = tags.iter().any(|t| matches!(t.shape, Shape::Line | Shape::Text));
        let duration_ms: u64 = if !dwell_targets.is_empty() {
            90_000
        } else if teaching {
            120_000
        } else {
            (8_000 + 2_500 * (count as u64 - 1)).min(20_000)
        };
        let payload = json!({
            "gen": gen,
            "points": points,
            "tour": tags.len() > 1,
            "durationMs": duration_ms,
        });

        let app = app.clone();
        let (mon_x, mon_y, mon_w, mon_h) = (screen.mon_x, screen.mon_y, screen.mon_w, screen.mon_h);
        std::thread::spawn(move || {
            let fresh = ensure_window(&app);
            if app.get_webview_window(super::POINT_LABEL).is_none() {
                return;
            }
            if fresh {
                // First creation: let the /point-overlay route hydrate before
                // the show event, or the listener misses it.
                std::thread::sleep(std::time::Duration::from_millis(1_400));
            }
            place_and_show(&app, mon_x, mon_y, mon_w, mon_h);
            let _ = app.emit_to(super::POINT_LABEL, "o8:point-show", payload);
            log::info!("[point-overlay] gen {gen}: showing {count} point(s) for {duration_ms}ms (dwell: {})", !dwell_targets.is_empty());

            if dwell_targets.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(duration_ms));
            } else {
                dwell_until_reached(&app, gen, duration_ms, &dwell_targets);
            }
            if GENERATION.load(Ordering::SeqCst) == gen {
                hide_with_fade(&app);
            }
        });
    }

    /// GUIDE lifecycle: poll the cursor (~150ms, the dock poller's cadence
    /// class) until it reaches a dwell target — "the user acted" — then grant
    /// a short grace so the ring is still there as they click, and return.
    /// Also returns at the cap, or immediately when a newer show supersedes
    /// this generation. Same physical-px coordinate math as
    /// `dock_window::cursor_probe` — cursor, window origin, and scale all from
    /// the same window so mixed-DPI monitors stay consistent.
    fn dwell_until_reached(app: &tauri::AppHandle, gen: u64, cap_ms: u64, targets: &[(f64, f64)]) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(cap_ms);
        let mut grace_until: Option<std::time::Instant> = None;
        loop {
            if GENERATION.load(Ordering::SeqCst) != gen {
                return; // superseded — the newer show owns the window now
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return;
            }
            if let Some(g) = grace_until {
                if now >= g {
                    return;
                }
            } else if cursor_near(app, targets) {
                grace_until = Some(now + std::time::Duration::from_millis(2_500));
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    /// Is the live cursor within ~56 logical px of any target? Targets are
    /// window-local logical; cursor + window origin are physical.
    fn cursor_near(app: &tauri::AppHandle, targets: &[(f64, f64)]) -> bool {
        let Some(window) = app.get_webview_window(super::POINT_LABEL) else {
            return false;
        };
        let Ok(cursor) = app.cursor_position() else {
            return false;
        };
        let Ok(pos) = window.outer_position() else {
            return false;
        };
        let Ok(scale) = window.scale_factor() else {
            return false;
        };
        let radius = 56.0 * scale;
        targets.iter().any(|(lx, ly)| {
            let tx = pos.x as f64 + lx * scale;
            let ty = pos.y as f64 + ly * scale;
            let dx = cursor.x - tx;
            let dy = cursor.y - ty;
            dx * dx + dy * dy <= radius * radius
        })
    }

    /// Immediately retire any visible pointers (called when a new agent task
    /// starts — stale pointers over a changed screen are worse than none).
    pub fn hide_now(app: &tauri::AppHandle) {
        GENERATION.fetch_add(1, Ordering::SeqCst);
        if app.get_webview_window(super::POINT_LABEL).is_some() {
            hide_with_fade(app);
        }
    }

    /// Emit the fade event, give the CSS fade its 500ms, then hide the window.
    fn hide_with_fade(app: &tauri::AppHandle) {
        let _ = app.emit_to(super::POINT_LABEL, "o8:point-hide", json!({}));
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            if let Some(w) = app.get_webview_window(super::POINT_LABEL) {
                let _ = w.hide();
            }
        });
    }

    /// Create the overlay window if missing (on the MAIN thread — NSWindow
    /// construction is main-thread-only; we block on an mpsc ack). Returns
    /// true when the window was freshly created this call.
    fn ensure_window(app: &tauri::AppHandle) -> bool {
        if app.get_webview_window(super::POINT_LABEL).is_some() {
            return false;
        }
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = tx.send(build_window(&app2));
        });
        rx.recv_timeout(std::time::Duration::from_secs(4)).unwrap_or(false)
    }

    /// Build the transparent click-through window over the bundled `/point-overlay`
    /// route. Same recipe as the dock (clearColor, level 25, nonactivating,
    /// all-spaces) PLUS ignore-cursor-events — this surface never takes input.
    fn build_window(app: &tauri::AppHandle) -> bool {
        use tauri::{WebviewUrl, WebviewWindowBuilder};

        if crate::dock_window::VOICE_PAGES_REMOVED {
            return false;
        }

        let base = match crate::dev_frontend::from_env() {
            Ok(Some(dev)) => dev.origin().to_string(),
            _ => format!("http://127.0.0.1:{}", API_PORT.get().copied().unwrap_or(3001)),
        };
        let url = format!("{base}/point-overlay");
        let parsed = match url.parse() {
            Ok(u) => u,
            Err(e) => {
                log::warn!("[point-overlay] bad url {url}: {e}");
                return false;
            }
        };

        let window = WebviewWindowBuilder::new(app, super::POINT_LABEL, WebviewUrl::External(parsed))
            .title("o8 pointer")
            .inner_size(800.0, 600.0) // placeholder — sized to the monitor at show
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .shadow(false)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .disable_drag_drop_handler()
            .build();

        let window = match window {
            Ok(w) => w,
            Err(e) => {
                log::warn!("[point-overlay] failed to build overlay window: {e}");
                return false;
            }
        };

        apply_macos_recipe(&window);
        // CLICK-THROUGH: the whole point (vs the dock, which takes clicks).
        let _ = window.set_ignore_cursor_events(true);
        log::info!("[point-overlay] overlay window created → {url}");
        true
    }

    /// Cover the captured monitor exactly, then order front without activating.
    fn place_and_show(app: &tauri::AppHandle, x: f64, y: f64, w: f64, h: f64) {
        let Some(window) = app.get_webview_window(super::POINT_LABEL) else {
            return;
        };
        let _ = window.set_size(tauri::LogicalSize::new(w, h));
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        let _ = window.set_ignore_cursor_events(true);
        order_front_nonactivating(&window);
    }

    /// Transparent + level-25 + nonactivating NSWindow recipe (mirrors
    /// dock_window::apply_macos_recipe — kept separate so the two windows'
    /// postures can diverge without coupling).
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
            // Safety: Tauri guarantees a live NSWindow for the window's
            // lifetime; this closure runs on the main thread.
            unsafe {
                let ns_window = &*ptr;
                let clear = NSColor::clearColor();
                ns_window.setBackgroundColor(Some(&clear));
                ns_window.setOpaque(false);
                ns_window.setLevel(25);
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

    /// Show without making key (orderFrontRegardless) — same rationale as the
    /// dock: the app the user is looking at must keep focus.
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

    #[cfg(test)]
    #[path = "localization_tests.rs"]
    mod localization_tests;
}

#[cfg(target_os = "macos")]
pub use overlay::{hide_now, init, show_points};

// ── Non-macOS no-ops ──
#[cfg(not(target_os = "macos"))]
pub fn init(_api_port: u16) {}
#[cfg(not(target_os = "macos"))]
pub fn hide_now(_app: &tauri::AppHandle) {}
