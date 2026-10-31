//! Classic composer selectors (LeadChip, ThinkingChip, ComposerPicker): the lead
//! chip with its provider mark, the house-rail model picker with favorites, and
//! the Thinking popover with the effort slider and the service tier (speed) picker.
use super::composer_picker::HOUSES;
use super::*;
use gpui::{AnyElement, Div, Entity, MouseButton, Pixels, SharedString, Stateful};
use std::path::PathBuf;

// Provider mark path data from Simple Icons (CC0 1.0), as in classic provider-marks.tsx.
const ANTHROPIC: &str = "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";
const OPENAI: &str = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const STAR: &str = "m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9L12 3Z";
const BRAIN: &str = "M9 4a3 3 0 0 0-5 2.3 3.5 3.5 0 0 0-1 6.5 3.5 3.5 0 0 0 2 6.4A3 3 0 0 0 11 20V5a2 2 0 0 0-2-1Zm6 0a3 3 0 0 1 5 2.3 3.5 3.5 0 0 1 1 6.5 3.5 3.5 0 0 1-2 6.4A3 3 0 0 1 13 20V5a2 2 0 0 1 2-1ZM5 10h3m-1 6h4m8-6h-3m1 6h-4";
const CHECK: &str = "m5 12 4 4L19 6";

/// The slider stops with THINKING_EFFORT_LABELS: id, long, short, consequence.
const EFFORTS: [(&str, &str, &str, &str); 5] = [
    ("low", "Low", "low", "fast, cheapest"),
    ("medium", "Medium", "medium", "balanced"),
    ("high", "High", "high", "default for real work"),
    ("xhigh", "Extra", "extra", "longer turns"),
    ("max", "Max", "max", "usage limits apply"),
];
/// Track width inside the 300px popover: shell, slider margin and padding removed.
const TRACK: f32 = 252.;

/// supportedEffortsForLead: the o8 lead and other runtimes offer no effort control.
fn efforts(backend: &str) -> &'static [(&'static str, &'static str, &'static str, &'static str)] {
    if matches!(backend, "claude" | "fable" | "codex" | "auto") {
        &EFFORTS
    } else {
        &[]
    }
}
fn hot(effort: &str) -> bool {
    matches!(effort, "xhigh" | "max" | "ultra")
}
/// A provider mark: filled Simple Icons paths, or classic's stroked glyphs.
#[derive(Clone, Copy)]
enum Glyph {
    Fill(&'static str),
    Stroke(&'static str, f32),
}
impl Glyph {
    fn icon(self, color: gpui::Rgba, size: f32) -> gpui::Svg {
        match self {
            Glyph::Fill(path) => crate::icon::fill(path, color, size),
            Glyph::Stroke(path, weight) => crate::icon::stroke(path, color, size, weight),
        }
    }
}
const O8: Glyph = Glyph::Stroke(
    "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 10.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 1 0 0-2.8",
    2.2,
);
const PI: Glyph = Glyph::Stroke("M4 8h16M8 8v12M16 8v9q0 3 3 3", 2.5);
const TERMINAL: Glyph = Glyph::Stroke("m5 7 5 5-5 5M12 19h7", 2.2);
// OpenCode's public silhouette, scaled from its 240x300 box onto the 24 grid.
const OPENCODE: Glyph = Glyph::Fill("M16.8 4.8H7.2v14.4h9.6V4.8ZM21.6 24H2.4V0h19.2v24Z");

/// COMPOSER_MODEL_GROUPS houses: key, label, the runtime that must be
/// installed, mark, and whether the models come from a live catalog. o8 is the
/// built-in agent (bundled Pi on the managed model) and is always shown.
const LEAD_HOUSES: [(&str, &str, &str, Glyph, bool); 8] = [
    (
        "claude",
        "Claude Code",
        "claude-code",
        Glyph::Fill(ANTHROPIC),
        false,
    ),
    ("codex", "Codex", "codex", Glyph::Fill(OPENAI), false),
    ("opencode", "OpenCode", "opencode", OPENCODE, true),
    ("o8", "o8", "", O8, false),
    ("pi", "Pi", "pi", PI, false),
    ("muse", "Muse Code", "muse", TERMINAL, true),
    // Hermes leads through `hermes acp` on its governed profile (#1304; worker
    // runtime by kvnloo in #3391). Shown to anyone who has it installed.
    ("hermes", "Hermes", "hermes", TERMINAL, true),
    ("acp", "Local ACP", "acp", TERMINAL, true),
];
fn house_of(backend: &str) -> &'static str {
    match backend {
        "claude" | "fable" => "claude",
        "opencode" => "opencode",
        "o8" => "o8",
        "pi" => "pi",
        "acp" => "acp",
        "hermes" => "hermes",
        "muse" => "muse",
        _ => "codex",
    }
}
fn mark(backend: &str) -> Option<Glyph> {
    match backend {
        "claude" | "fable" => Some(Glyph::Fill(ANTHROPIC)),
        "codex" => Some(Glyph::Fill(OPENAI)),
        "o8" => Some(O8),
        "pi" => Some(PI),
        "opencode" => Some(OPENCODE),
        "muse" | "hermes" | "acp" => Some(TERMINAL),
        _ => None,
    }
}
/// The chip's short name, classic's triggerLabel: the mark stands in for
/// "GPT" or "Claude" ("6.1 Sol", "Opus 5.5", "Astra").
fn short_label(model: &str, full: &str) -> String {
    match model {
        "gpt-6-astra" => return "Astra".into(),
        "gpt-5.6-terra" => return "Terra".into(),
        _ => {}
    }
    ["GPT-", "GPT ", "Claude "]
        .iter()
        .find_map(|prefix| full.strip_prefix(prefix))
        .unwrap_or(full)
        .to_owned()
}
fn tint(color: gpui::Rgba, alpha: f32) -> gpui::Rgba {
    gpui::Rgba { a: alpha, ..color }
}
fn light(text: impl Into<SharedString>, size: f32, color: gpui::Rgba) -> Div {
    div()
        .text_size(px(size))
        .font_weight(gpui::FontWeight::LIGHT)
        .text_color(color)
        .child(text.into())
}

// Native counterparts of classic's localStorage preferences: service tiers by
// backend:model and lead favorites. They never touch the CLI's own config.
fn store_path(name: &str, _cx: &App) -> Option<PathBuf> {
    #[cfg(test)]
    let root = _cx
        .try_global::<crate::composer::mode_store::TestRoot>()?
        .0
        .clone();
    #[cfg(not(test))]
    let root = PathBuf::from(std::env::var_os("HOME")?).join(".o8/next");
    Some(root.join(name))
}
thread_local! {
    static STORES: RefCell<HashMap<PathBuf, Value>> = RefCell::new(HashMap::new());
}
fn read_store(name: &str, cx: &App) -> Value {
    let Some(path) = store_path(name, cx) else {
        return json!({});
    };
    STORES.with_borrow_mut(|stores| {
        stores
            .entry(path.clone())
            .or_insert_with(|| {
                std::fs::read(&path)
                    .ok()
                    .filter(|bytes| bytes.len() <= 256 * 1024)
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({}))
            })
            .clone()
    })
}
fn write_store(name: &str, value: Value, cx: &App) -> bool {
    let Some(path) = store_path(name, cx) else {
        return false;
    };
    let temp = path.with_extension("json.tmp");
    let written = path
        .parent()
        .is_some_and(|dir| std::fs::create_dir_all(dir).is_ok())
        && std::fs::write(&temp, value.to_string()).is_ok()
        && std::fs::rename(&temp, &path).is_ok();
    if written {
        STORES.with_borrow_mut(|stores| stores.insert(path, value));
    }
    written
}
/// The speed chosen for this lead, sent as routing.serviceTier like classic.
pub(super) fn service_tier(backend: &str, model: &str, cx: &App) -> Option<String> {
    if !matches!(backend, "codex" | "claude") {
        return None;
    }
    read_store("composer-service-tiers.json", cx)[format!("{backend}:{model}")]
        .as_str()
        .map(str::to_owned)
}
fn favorites(cx: &App) -> Vec<(String, String)> {
    read_store("model-favorites.json", cx)["lead"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| {
            Some((
                f["house"].as_str()?.to_owned(),
                f["id"].as_str()?.to_owned(),
            ))
        })
        .collect()
}

impl Surface {
    /// LeadChip: the provider mark and the lead model's name.
    pub(super) fn lead_chip(
        &self,
        routing: &Value,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let backend = routing["backend"].as_str().unwrap_or("");
        // Q 2026-10-31: the mark names the provider, so the chip drops it
        // from the name ("6.1 Sol", "Opus 5.5"); the tooltip keeps the full name.
        let full = routing["model"].as_str().map_or("Model".into(), |m| {
            crate::composer::controls::model_label(m)
        });
        let label = short_label(routing["model"].as_str().unwrap_or(""), &full);
        let tip = SharedString::from(format!("Orchestrator: {full}"));
        let open = self.composer.read(cx).controls.open == Some("model");
        self.composer_button("composer-model", "", enabled, cx, |s, w, cx| {
            s.open_composer_picker("model", w, cx)
        })
        .h(px(22.))
        .gap(px(5.))
        .max_w(px(190.))
        .overflow_hidden()
        .font_weight(gpui::FontWeight::LIGHT)
        .when(open, |chip| chip.bg(theme().hover))
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.clone())).into())
        .when_some(mark(backend), |chip, glyph| {
            chip.child(glyph.icon(theme().text_secondary, 13.))
        })
        .child(div().min_w_0().truncate().child(label))
    }

    /// ThinkingChip: one bar per effort stop, lit through the current one, and
    /// the effort word. The top stops read in the brand orange.
    pub(super) fn thinking_chip(
        &self,
        routing: &Value,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Option<Stateful<Div>> {
        let stops = efforts(routing["backend"].as_str().unwrap_or(""));
        if stops.is_empty() {
            return None;
        }
        let effort = routing["effort"].as_str().unwrap_or("high");
        let index = stops.iter().position(|s| s.0 == effort).unwrap_or(0);
        let accent = if hot(effort) {
            crate::theme::brand_orange()
        } else {
            theme().accent
        };
        let open = self.composer.read(cx).controls.open == Some("effort");
        let mut bars = div().flex().items_end().gap(px(2.)).h(px(10.));
        for i in 0..stops.len() {
            bars = bars.child(
                div()
                    .w(px(2.))
                    .h(px(4. + i as f32))
                    .rounded(px(2.))
                    .bg(if i <= index { accent } else { theme().border }),
            );
        }
        // Bars only on the chip (Q 2026-10-31); the word moves to the tooltip.
        let word = stops
            .iter()
            .find(|s| s.0 == effort)
            .map_or(effort.to_owned(), |s| s.1.to_owned());
        let tip = SharedString::from(format!("Thinking: {word}"));
        Some(
            self.composer_button("composer-effort", "", enabled, cx, |s, w, cx| {
                s.open_composer_picker("effort", w, cx)
            })
            .h(px(22.))
            .px(px(5.))
            .gap(px(5.))
            .font_weight(gpui::FontWeight::LIGHT)
            .text_color(accent)
            .when(open, |chip| chip.bg(theme().hover))
            .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.clone())).into())
            .child(bars),
        )
    }

    /// Opening a chip: the model picker starts on Favorites when there are any,
    /// else the lead's house; the Thinking popover checks this lead's speeds.
    pub(super) fn prepare_selector(&mut self, picker: &str, cx: &mut Context<Self>) {
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        let backend = routing["backend"].as_str().unwrap_or("").to_owned();
        let model = routing["model"].as_str().unwrap_or("").to_owned();
        if picker == "model" {
            let house = if favorites(cx).is_empty() {
                house_of(&backend)
            } else {
                "favorites"
            };
            self.composer
                .update(cx, |i, _| i.controls.lead_house = house.to_owned());
            self.load_inventory(cx);
            self.load_catalogue(house, cx);
            if let Some(input) = self.composer.read(cx).controls.model.clone() {
                input.update(cx, |i, cx| {
                    i.set_text("", cx);
                    i.placeholder = "Search models".into();
                });
                cx.observe(&input, |_, _, cx| cx.notify()).detach();
            }
        } else if picker == "effort" {
            self.check_service_tiers(backend, model, cx);
        }
    }

    fn check_service_tiers(&mut self, backend: String, model: String, cx: &mut Context<Self>) {
        let key = format!("{backend}:{model}");
        if !matches!(backend.as_str(), "codex" | "claude")
            || self.composer.read(cx).controls.tiers.contains_key(&key)
        {
            return;
        }
        self.composer.update(cx, |i, _| {
            i.controls.tiers.insert(key.clone(), Value::Null);
        });
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            client
                .get(
                    "/api/runtime/service-tiers",
                    &[("backend", &backend), ("model", &model)],
                )
                .unwrap_or_else(|_| json!({"options": [], "error": "Service tiers unavailable"}))
        });
        let editor = self.composer.downgrade();
        cx.spawn(async move |this, cx| {
            let answer: Value = task.await;
            let _ = editor.update(cx, |i, cx| {
                i.controls.tiers.insert(key, answer);
                cx.notify();
            });
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }

    /// The Thinking popover: "Thinking · model", the effort slider, and the
    /// service tier picker for Codex and Claude leads.
    pub(super) fn thinking_menu(
        &mut self,
        routing: &Value,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let backend = routing["backend"].as_str().unwrap_or("").to_owned();
        let model = routing["model"].as_str().unwrap_or("").to_owned();
        let stops = efforts(&backend);
        let effort = routing["effort"].as_str().unwrap_or("high").to_owned();
        let current = stops.iter().position(|s| s.0 == effort).unwrap_or(0);
        let preview = self.composer.read(cx).controls.effort_preview;
        let shown = preview
            .unwrap_or(current)
            .min(stops.len().saturating_sub(1));
        let mut out = vec![
            light(
                format!(
                    "Thinking · {}",
                    crate::composer::controls::model_label(&model)
                ),
                11.,
                theme().text_muted,
            )
            .px(px(10.))
            .pt(px(4.))
            .pb(px(6.))
            .into_any_element(),
        ];
        if stops.is_empty() {
            out.push(
                light("This lead manages its own effort.", 11., theme().text_muted)
                    .px(px(10.))
                    .pb(px(6.))
                    .into_any_element(),
            );
            return out;
        }
        let (id, long, _, detail) = stops[shown];
        let accent = if hot(id) {
            crate::theme::brand_orange()
        } else {
            theme().accent
        };
        let progress = if stops.len() < 2 {
            0.
        } else {
            shown as f32 / (stops.len() - 1) as f32
        };
        let at = |i: usize| 11. + (TRACK - 22.) * i as f32 / (stops.len() - 1).max(1) as f32;
        let mut track = div()
            .id("composer-effort-slider")
            .debug_selector(|| "composer-effort-slider".into())
            .relative()
            .h(px(42.))
            .w(px(TRACK))
            .when(!busy, |t| t.cursor_pointer())
            .child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(px(12.))
                    .h(px(18.))
                    .rounded_full()
                    .bg(tint(theme().text_faint, 0.15)),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .top(px(12.))
                    .w(px(at(shown)))
                    .h(px(18.))
                    .rounded_full()
                    .bg(gpui::linear_gradient(
                        90.,
                        gpui::linear_color_stop(tint(theme().accent, 0.32), 0.),
                        gpui::linear_color_stop(accent, 1.),
                    )),
            );
        for i in 0..stops.len() {
            track = track.child(
                div()
                    .absolute()
                    .left(px(at(i) - 2.))
                    .top(px(19.))
                    .size(px(4.))
                    .rounded_full()
                    .opacity(0.65)
                    .bg(if i <= shown {
                        tint(crate::theme::on_accent(), 0.55)
                    } else {
                        theme().text_faint
                    }),
            );
        }
        track = track.child(
            div()
                .absolute()
                .left(px(11. + (TRACK - 22.) * progress - 11.))
                .top(px(10.))
                .size(px(22.))
                .rounded_full()
                .bg(accent)
                .flex()
                .items_center()
                .justify_center()
                .shadow_sm()
                .child(crate::icon::stroke(
                    BRAIN,
                    crate::theme::on_accent(),
                    14.,
                    1.8,
                )),
        );
        // Press and drag previews a stop; release commits it, as on the desktop.
        let stop_at = move |s: &Surface, x: Pixels, cx: &App| {
            let bounds = *s
                .composer
                .read(cx)
                .controls
                .prompt
                .anchors
                .get("effort-track")?;
            let p = ((f32::from(x - bounds.left()) - 11.) / (f32::from(bounds.size.width) - 22.))
                .clamp(0., 1.);
            Some((p * (stops.len() - 1) as f32).round() as usize)
        };
        let track = self
            .track_prompt_anchor(track, "effort-track")
            .when(!busy, |t| {
                t.on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |s, e: &gpui::MouseDownEvent, _, cx| {
                        let stop = stop_at(s, e.position.x, cx);
                        s.composer.update(cx, |i, cx| {
                            i.controls.effort_preview = stop;
                            cx.notify();
                        });
                        cx.stop_propagation();
                    }),
                )
                .on_mouse_move(cx.listener(move |s, e: &gpui::MouseMoveEvent, _, cx| {
                    if e.pressed_button != Some(MouseButton::Left)
                        || s.composer.read(cx).controls.effort_preview.is_none()
                    {
                        return;
                    }
                    let stop = stop_at(s, e.position.x, cx);
                    if stop.is_some() && stop != s.composer.read(cx).controls.effort_preview {
                        s.composer.update(cx, |i, cx| {
                            i.controls.effort_preview = stop;
                            cx.notify();
                        });
                    }
                }))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(move |s, _, w, cx| s.finish_effort_drag(stops, w, cx)),
                )
                .on_mouse_up_out(
                    MouseButton::Left,
                    cx.listener(move |s, _, w, cx| s.finish_effort_drag(stops, w, cx)),
                )
            });
        let mut labels = div().flex().mx(px(-6.));
        for (i, &(value, label, _, _)) in stops.iter().enumerate() {
            labels = labels.child(
                self.composer_button(
                    &format!("effort-{value}"),
                    "",
                    !busy,
                    cx,
                    move |s, w, cx| s.composer_choice("effort", value, w, cx),
                )
                .flex_1()
                .min_w_0()
                .h(px(18.))
                .px(px(0.))
                .justify_center()
                .text_size(px(9.))
                .font_weight(gpui::FontWeight::LIGHT)
                .text_color(if i == shown {
                    accent
                } else {
                    theme().text_faint
                })
                .child(label),
            );
        }
        let slider = div()
            .mx(px(8.))
            .mt(px(2.))
            .mb(px(6.))
            .p(px(10.))
            .rounded(px(12.))
            .bg(theme().hover)
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .min_h(px(24.))
                    .child(
                        div()
                            .text_size(px(17.))
                            .text_color(if hot(id) { accent } else { theme().text })
                            .child(long),
                    )
                    .when(effort != "high", |row| {
                        row.child(
                            self.composer_button("effort-reset", "", !busy, cx, |s, w, cx| {
                                s.composer_choice("effort", "high", w, cx)
                            })
                            .h(px(18.))
                            .px(px(0.))
                            .text_size(px(10.))
                            .font_weight(gpui::FontWeight::LIGHT)
                            .text_color(theme().accent)
                            .child("Reset to High"),
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .justify_between()
                    .pt(px(4.))
                    .child(light("Faster", 10., theme().text_faint))
                    .child(light("More thinking", 10., theme().text_faint)),
            )
            .child(track)
            .child(labels)
            .child(
                light(
                    detail,
                    11.,
                    if hot(id) { accent } else { theme().text_muted },
                )
                .mt(px(8.))
                .min_h(px(15.)),
            );
        out.push(slider.into_any_element());
        if let Some(tiers) = self.service_tier_section(&backend, &model, busy, cx) {
            out.push(tiers);
        }
        out
    }

    fn finish_effort_drag(
        &mut self,
        stops: &'static [(&'static str, &'static str, &'static str, &'static str)],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(stop) = self
            .composer
            .update(cx, |i, _| i.controls.effort_preview.take())
        else {
            return;
        };
        cx.notify();
        let current = self.composer_routing(cx).unwrap_or(Value::Null)["effort"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        if let Some(&(value, ..)) = stops.get(stop).filter(|s| s.0 != current) {
            self.composer_choice("effort", value, window, cx);
        }
    }

    /// ServiceTierPicker: the speeds this lead offers, from the runtime catalog.
    fn service_tier_section(
        &mut self,
        backend: &str,
        model: &str,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !matches!(backend, "codex" | "claude") {
            return None;
        }
        let snapshot = self
            .composer
            .read(cx)
            .controls
            .tiers
            .get(&format!("{backend}:{model}"))
            .cloned()
            .unwrap_or(Value::Null);
        let requested = service_tier(backend, model, cx);
        let selected = requested
            .clone()
            .or_else(|| snapshot["configuredTier"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "default".into());
        let options = snapshot["options"].as_array().cloned().unwrap_or_default();
        let chosen = options.iter().find(|o| o["id"] == selected.as_str());
        let status = if snapshot.is_null() {
            "Checking…".to_owned()
        } else if let Some(option) = chosen {
            option["label"].as_str().unwrap_or("").to_owned()
        } else if requested.is_some() {
            "Selection unavailable".into()
        } else {
            String::new()
        };
        let mut radios = div().flex().gap(px(4.));
        for option in &options {
            let Some(id) = option["id"].as_str().map(str::to_owned) else {
                continue;
            };
            let on = id == selected;
            let (b, m) = (backend.to_owned(), model.to_owned());
            let tier = id.clone();
            radios = radios.child(
                self.composer_button(&format!("tier-{id}"), "", !busy, cx, move |s, _, cx| {
                    s.pick_service_tier(&b, &m, &tier, cx)
                })
                .flex_1()
                .min_w_0()
                .h(px(28.))
                .justify_center()
                .rounded(px(8.))
                .border_1()
                .border_color(theme().border)
                .font_weight(gpui::FontWeight::LIGHT)
                .when(on, |r| {
                    r.bg(tint(theme().accent, 0.14)).text_color(theme().accent)
                })
                .child(option["label"].as_str().unwrap_or(&id).to_owned()),
            );
        }
        let note = if snapshot.is_null() || snapshot["error"].is_string() {
            None
        } else if chosen.is_none() {
            Some("This tier is no longer available. Choose Standard before sending.".to_owned())
        } else {
            Some(
                chosen
                    .and_then(|o| o["description"].as_str())
                    .filter(|d| !d.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        if options.len() > 1 {
                            "Applies to the next turn. Faster tiers can use more allowance or paid credits.".into()
                        } else {
                            "Standard speed for this model.".into()
                        }
                    }),
            )
        };
        let retry = snapshot["error"].as_str().map(|error| {
            let (b, m) = (backend.to_owned(), model.to_owned());
            self.composer_button("tier-retry", "", true, cx, move |s, _, cx| {
                s.composer.update(cx, |i, _| {
                    i.controls.tiers.remove(&format!("{b}:{m}"));
                });
                s.check_service_tiers(b.clone(), m.clone(), cx);
            })
            .h(px(18.))
            .px(px(0.))
            .text_size(px(10.5))
            .text_color(theme().accent)
            .child(format!("{error} · Retry"))
        });
        Some(
            div()
                .mt(px(8.))
                .pt(px(10.))
                .px(px(10.))
                .pb(px(2.))
                .border_t_1()
                .border_color(theme().border)
                .flex()
                .flex_col()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .mb(px(7.))
                        .child(light("Service tier", 11., theme().text_muted))
                        .child(light(status, 10., theme().text_muted)),
                )
                .child(radios)
                .children(retry)
                .children(note.map(|n| {
                    light(n, 10., theme().text_muted)
                        .mt(px(7.))
                        .line_height(px(14.))
                }))
                .into_any_element(),
        )
    }

    fn pick_service_tier(
        &mut self,
        backend: &str,
        model: &str,
        tier: &str,
        cx: &mut Context<Self>,
    ) {
        let mut store = read_store("composer-service-tiers.json", cx);
        store[format!("{backend}:{model}")] = json!(tier);
        if !write_store("composer-service-tiers.json", store, cx) {
            self.composer.update(cx, |i, _| {
                i.controls.error = "Could not save this choice.".into()
            });
        }
        cx.notify();
    }

    fn toggle_favorite(&mut self, backend: &str, model: &str, cx: &mut Context<Self>) {
        let mut list = favorites(cx);
        let entry = (backend.to_owned(), model.to_owned());
        if let Some(index) = list.iter().position(|f| f == &entry) {
            list.remove(index);
        } else {
            list.push(entry);
        }
        let lead: Vec<Value> = list
            .iter()
            .map(|(house, id)| json!({"house": house, "id": id}))
            .collect();
        let mut store = read_store("model-favorites.json", cx);
        store["lead"] = json!(lead);
        if !write_store("model-favorites.json", store, cx) {
            self.composer.update(cx, |i, _| {
                i.controls.error = "Could not save this favorite.".into()
            });
        }
        cx.notify();
    }

    /// The installed runtimes (classic useRuntimeInventory), once per open.
    fn load_inventory(&mut self, cx: &mut Context<Self>) {
        if !self.composer.read(cx).controls.inventory.is_null() {
            return;
        }
        self.composer
            .update(cx, |i, _| i.controls.inventory = json!("loading"));
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            client
                .get("/api/panel/operator-defaults", &[])
                .ok()
                .and_then(|v: Value| v["dispatchableRuntimes"].as_array().cloned())
                .map_or(json!("failed"), Value::Array)
        });
        let editor = self.composer.downgrade();
        cx.spawn(async move |this, cx| {
            let inventory = task.await;
            let _ = editor.update(cx, |i, cx| {
                i.controls.inventory = inventory;
                cx.notify();
            });
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }

    /// A searchable house's live model catalog (AcpModelPicker).
    fn load_catalogue(&mut self, house: &str, cx: &mut Context<Self>) {
        if !LEAD_HOUSES.iter().any(|h| h.0 == house && h.4)
            || self
                .composer
                .read(cx)
                .controls
                .catalogues
                .contains_key(house)
        {
            return;
        }
        let key = house.to_owned();
        self.composer.update(cx, |i, _| {
            i.controls.catalogues.insert(key.clone(), Value::Null);
        });
        let client = self.client.clone();
        let backend = key.clone();
        let task = cx.background_executor().spawn(async move {
            client
                .get("/api/orchestrator/backend-models", &[("backend", &backend)])
                .unwrap_or_else(|_| json!({"available": false, "groups": []}))
        });
        let editor = self.composer.downgrade();
        cx.spawn(async move |this, cx| {
            let catalogue: Value = task.await;
            let _ = editor.update(cx, |i, cx| {
                i.controls.catalogues.insert(key, catalogue);
                cx.notify();
            });
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }

    /// Every lead house the operator has installed (o8 always). Worker-only
    /// runtimes stay out of the picker (Q 2026-10-31: keep it clean); they
    /// belong to Settings and the transcript. key, label, mark, can lead, ready.
    fn rail_houses(&self, lead: &str, cx: &App) -> Vec<(String, String, Glyph, bool, bool)> {
        let inventory = self
            .composer
            .read(cx)
            .controls
            .inventory
            .as_array()
            .cloned();
        let item = |runtime: &str| {
            inventory
                .as_ref()
                .and_then(|items| items.iter().find(|i| i["id"] == runtime).cloned())
        };
        let shown = |i: &Value| {
            i["available"] == true
                || i["installed"] == true
                || i["builtIn"].is_object()
                || matches!(
                    i["unavailableReason"].as_str(),
                    Some("needs_auth" | "needs_restart")
                )
        };
        let mut houses = vec![];
        for &(key, label, runtime, glyph, _) in &LEAD_HOUSES {
            let found = item(runtime);
            let visible = key == lead
                || key == "o8"
                || found.as_ref().is_some_and(shown)
                || (inventory.is_none() && matches!(key, "claude" | "codex"));
            if visible {
                let ready = key == "o8"
                    || found
                        .as_ref()
                        .map_or(inventory.is_none(), |i| i["available"] == true);
                houses.push((key.to_owned(), label.to_owned(), glyph, true, ready));
            }
        }
        houses
    }

    /// ComposerPicker: a rail of houses (Favorites, then every runtime's mark)
    /// beside search and the model rows, starred favorites first.
    pub(super) fn lead_menu(
        &mut self,
        routing: &Value,
        busy: bool,
        search: Option<Entity<Composer>>,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let lead_backend = routing["backend"].as_str().unwrap_or("").to_owned();
        let current = routing["model"].as_str().unwrap_or("").to_owned();
        let house = self.composer.read(cx).controls.lead_house.clone();
        let query = search
            .as_ref()
            .map(|s| s.read(cx).text.trim().to_owned())
            .unwrap_or_default();
        let needle = query.to_lowercase();
        let starred = favorites(cx);
        let houses = self.rail_houses(house_of(&lead_backend), cx);
        let mut rail = div()
            .id("composer-lead-rail")
            .w(px(44.))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(4.))
            .py(px(8.))
            .overflow_y_scroll()
            .border_r_1()
            .border_color(theme().border);
        let entries = std::iter::once((
            "favorites".to_owned(),
            "Favorites".to_owned(),
            Glyph::Fill(STAR),
            true,
            true,
        ))
        .chain(houses.iter().cloned());
        for (key, label, glyph, lead, ready) in entries {
            let on = house == key;
            let color = if on {
                theme().accent
            } else if lead {
                theme().text_muted
            } else {
                theme().text_faint
            };
            let icon = if key == "favorites" && !on {
                crate::icon::stroke(STAR, color, 14., 1.7)
            } else {
                glyph.icon(color, if key == "favorites" { 14. } else { 17. })
            };
            let input = search.clone();
            let tip = SharedString::from(if ready {
                label.clone()
            } else {
                format!("{label} · not signed in")
            });
            let pick = key.clone();
            rail = rail.child(
                self.composer_button(
                    &format!("lead-house-{key}"),
                    "",
                    true,
                    cx,
                    move |s, _, cx| {
                        s.composer.update(cx, |i, cx| {
                            i.controls.lead_house = pick.clone();
                            cx.notify();
                        });
                        s.load_catalogue(&pick, cx);
                        if let Some(input) = &input {
                            input.update(cx, |i, cx| i.set_text("", cx));
                        }
                        cx.notify();
                    },
                )
                .size(px(32.))
                .px(px(0.))
                .justify_center()
                .rounded(px(9.))
                .when(on, |b| b.bg(tint(theme().accent, 0.14)))
                .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.clone())).into())
                .child(icon),
            );
        }
        let ready_house = |key: &str| houses.iter().any(|h| h.0 == key && h.3 && h.4);
        let house_label = |key: &str| {
            houses
                .iter()
                .find(|h| h.0 == key)
                .map_or_else(|| key.to_owned(), |h| h.1.clone())
        };
        // (backend, id, label, house) for each model the visible lead houses offer.
        let catalogues = self.composer.read(cx).controls.catalogues.clone();
        let models_of = |key: &str| -> Vec<(String, String, String, String)> {
            match key {
                "claude" | "codex" => HOUSES
                    .iter()
                    .flat_map(|(_, models)| models.iter())
                    .filter(|m| house_of(m.0) == key)
                    .map(|m| (m.0.into(), m.1.into(), m.2.into(), key.into()))
                    .collect(),
                "o8" => vec![("o8".into(), "o8-free".into(), "o8".into(), "o8".into())],
                "pi" => vec![("pi".into(), "pi".into(), "Pi".into(), "pi".into())],
                _ => catalogues
                    .get(key)
                    .and_then(|c| c["groups"].as_array())
                    .into_iter()
                    .flatten()
                    .flat_map(|g| g["models"].as_array().cloned().unwrap_or_default())
                    .filter_map(|m| {
                        let id = m["id"].as_str()?.to_owned();
                        let label = m["label"].as_str().unwrap_or(&id).to_owned();
                        Some((key.to_owned(), id, label, key.to_owned()))
                    })
                    .collect(),
            }
        };
        let lead_keys: Vec<String> = houses.iter().filter(|h| h.3).map(|h| h.0.clone()).collect();
        let mut picks: Vec<(String, String, String, Option<String>)> = if house == "favorites" {
            starred
                .iter()
                .map(|(backend, id)| {
                    let key = house_of(backend);
                    let label = models_of(key)
                        .into_iter()
                        .find(|m| &m.1 == id)
                        .map_or_else(|| crate::composer::controls::model_label(id), |m| m.2);
                    (backend.clone(), id.clone(), label, Some(house_label(key)))
                })
                .collect()
        } else if !needle.is_empty() {
            lead_keys
                .iter()
                .flat_map(|key| models_of(key))
                .map(|m| (m.0, m.1, m.2, Some(house_label(&m.3))))
                .collect()
        } else {
            models_of(&house)
                .into_iter()
                .map(|m| {
                    let detail = match m.3.as_str() {
                        "o8" => Some("Managed model · built-in Pi agent".to_owned()),
                        "pi" => Some("Your Pi setup and its model".to_owned()),
                        _ => None,
                    };
                    (m.0, m.1, m.2, detail)
                })
                .collect()
        };
        picks.retain(|(backend, id, label, _)| {
            needle.is_empty()
                || format!("{label} {id} {backend}")
                    .to_lowercase()
                    .contains(&needle)
        });
        picks.truncate(300);
        picks.sort_by_key(|(backend, id, ..)| {
            !starred.iter().any(|f| &f.0 == backend && &f.1 == id)
        });
        let mut rows = div()
            .id("composer-lead-scroll")
            .flex_1()
            .min_h_0()
            .max_h(px(320.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(1.));
        let empty = picks.is_empty();
        for (backend, id, label, detail) in picks {
            let selected = backend == lead_backend && id == current;
            let favorite = starred.iter().any(|f| f.0 == backend && f.1 == id);
            let enabled = !busy && ready_house(house_of(&backend));
            let (pick_backend, pick_id) = (backend.clone(), id.clone());
            let (star_backend, star_id) = (backend.clone(), id.clone());
            rows = rows.child(
                div()
                    .flex()
                    .items_center()
                    .min_w_0()
                    .rounded(px(8.))
                    .when(selected, |r| r.bg(theme().hover))
                    .child(
                        self.composer_button(
                            &format!("model-{id}"),
                            "",
                            enabled,
                            cx,
                            move |s, w, cx| s.choose_lead(&pick_backend, &pick_id, w, cx),
                        )
                        .flex_1()
                        .min_w_0()
                        .h(px(if detail.is_some() { 38. } else { 32. }))
                        .pl(px(8.))
                        .pr(px(4.))
                        .gap(px(8.))
                        .rounded(px(8.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(light(label, 12.5, theme().text).truncate())
                                .children(
                                    detail.map(|d| light(d, 10., theme().text_muted).truncate()),
                                ),
                        )
                        .when(selected, |r| {
                            r.child(crate::icon::stroke(CHECK, theme().accent, 12., 2.))
                        }),
                    )
                    .child(
                        self.composer_button(
                            &format!("model-star-{id}"),
                            "",
                            true,
                            cx,
                            move |s, _, cx| s.toggle_favorite(&star_backend, &star_id, cx),
                        )
                        .w(px(28.))
                        .h(px(30.))
                        .px(px(0.))
                        .justify_center()
                        .child(if favorite {
                            crate::icon::fill(STAR, theme().accent, 14.).into_any_element()
                        } else {
                            crate::icon::stroke(STAR, theme().text_muted, 14., 1.7)
                                .into_any_element()
                        }),
                    ),
            );
        }
        let loading = catalogues.get(house.as_str()).is_some_and(Value::is_null);
        if empty {
            let note = if loading {
                "Loading models…".into()
            } else if house == "favorites" && needle.is_empty() {
                "Star a model to keep it here.".into()
            } else if needle.is_empty() {
                format!("{} has no models available.", house_label(&house))
            } else {
                "No models match this search.".into()
            };
            rows = rows.child(light(note, 11., theme().text_muted).p(px(12.)));
        } else if house != "favorites" && needle.is_empty() && !ready_house(&house) {
            rows = rows.child(
                light(
                    format!(
                        "Sign in to {} in Settings to lead with it.",
                        house_label(&house)
                    ),
                    11.,
                    theme().text_muted,
                )
                .p(px(8.)),
            );
        }
        // Native keeps a free model id as the last row: any id the lead's
        // runtime accepts, without changing runtime.
        if !query.is_empty() {
            let custom = query.clone();
            rows = rows.child(
                self.composer_button("composer-model-save", "", !busy, cx, move |s, w, cx| {
                    s.composer_choice("model", &custom, w, cx)
                })
                .w_full()
                .h(px(32.))
                .pl(px(8.))
                .rounded(px(8.))
                .child(light(
                    format!("Use model id “{query}”"),
                    12.,
                    theme().text_secondary,
                )),
            );
        }
        let content = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .pt(px(8.))
            .px(px(6.))
            .pb(px(6.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .min_h(px(24.))
                    .px(px(8.))
                    .child(light("Orchestrator", 11., theme().text_muted))
                    .child(light(
                        if house == "favorites" {
                            "Favorites".to_owned()
                        } else {
                            house_label(&house)
                        },
                        11.,
                        theme().text_muted,
                    )),
            )
            .children(search.map(|input| {
                div()
                    .id("composer-model-input")
                    .debug_selector(|| "composer-model-input".into())
                    .min_h(px(30.))
                    .px(px(8.))
                    .mb(px(4.))
                    .flex()
                    .items_center()
                    .border_b_1()
                    .border_color(theme().border)
                    .text_size(px(12.))
                    .child(div().flex_1().min_w_0().child(input))
            }))
            .child(rows)
            .when(busy, |c| {
                c.child(light("Applying selection…", 11., theme().text_muted).p(px(8.)))
            });
        vec![rail.into_any_element(), content.into_any_element()]
    }
}
