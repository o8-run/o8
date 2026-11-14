//! The edit/revert chip and glints drawn below the dock capsule (batch 3).
//! Their timed dismissal and fade run here from timestamps the web dock sends
//! once; a revert click is an intent the web dock runs, as for the capsules.
use super::{Pill, Snapshot, capsules};
use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use serde::Deserialize;
use serde_json::json;

/// The longest a static frame (fleet capsule or chip/glint alone) holds the
/// panel without a keep-alive. Shared with the web dock (pill-timing.json).
pub(crate) const STATIC_LEASE_MS: u64 = 5000;
/// The web glint's opacity transition (DockGlint: 0.5 s ease).
const GLINT_FADE_MS: u64 = 500;
/// The native chip has a fixed footprint so its hit rectangle is exact; long
/// app names are truncated (the web chip sizes to its text).
const CHIP: (f64, f64) = (248., 24.);
const GAP: f64 = 6.;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditChip {
    pub id: u64,
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub status: String,
    /// Epoch milliseconds when the web chip's dismissal timer fires.
    #[serde(default)]
    pub until: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Glint {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tone: String,
    /// Epoch milliseconds: the fade starts, then the glint is gone.
    #[serde(default)]
    pub fade_at: u64,
    #[serde(default)]
    pub until: u64,
}

impl EditChip {
    fn ready(&self) -> bool {
        self.status == "ready"
    }
    /// EditRevertChip's words for each status.
    pub(crate) fn label(&self) -> String {
        match self.status.as_str() {
            "reverted" => "Reverted".into(),
            "copied" => "Original copied".into(),
            "pending" => "Reverting…".into(),
            _ if self.app.is_empty() => "Rewrote — Revert".into(),
            _ => format!("Rewrote in {} — Revert", self.app),
        }
    }
}

impl Glint {
    pub(crate) fn opacity(&self, now: u64) -> f32 {
        if now < self.fade_at {
            1.
        } else {
            (1. - now.saturating_sub(self.fade_at) as f32 / GLINT_FADE_MS as f32).clamp(0., 1.)
        }
    }
    fn phase(&self, now: u64) -> u8 {
        if now >= self.until {
            2
        } else if now >= self.fade_at {
            1
        } else {
            0
        }
    }
}

pub(crate) fn is_static(state: &str) -> bool {
    matches!(state, "workers" | "extras")
}

impl Snapshot {
    pub(crate) fn edit_live(&self, now: u64) -> Option<&EditChip> {
        self.edit.as_ref().filter(|edit| now < edit.until)
    }
    pub(crate) fn glint_live(&self, now: u64) -> Option<&Glint> {
        self.glint.as_ref().filter(|glint| now < glint.until)
    }
    pub(crate) fn extras_live(&self, now: u64) -> bool {
        self.edit_live(now).is_some() || self.glint_live(now).is_some()
    }
}

impl Pill {
    /// The lease this frame grants: static frames may hold up to the static
    /// lease; every other state keeps the 750 ms lease.
    pub(crate) fn lease_for(snapshot: &Snapshot) -> u64 {
        if is_static(&snapshot.state) {
            snapshot.hold_ms.clamp(750, STATIC_LEASE_MS)
        } else {
            750
        }
    }

    /// Run from the visible maintenance tick: true when the chip or glint
    /// changed phase (appeared, began fading, or ended) and needs a redraw. A
    /// chip/glint-only frame hides itself when both have ended, without a frame.
    pub(crate) fn extras_tick(&mut self, now: u64) -> bool {
        if !self.target {
            return false;
        }
        let phase = (
            self.snapshot.edit_live(now).is_some(),
            self.snapshot
                .glint
                .as_ref()
                .map_or(2, |glint| glint.phase(now)),
        );
        let changed = phase != self.extras_phase;
        self.extras_phase = phase;
        if self.snapshot.state == "extras" && !self.snapshot.extras_live(now) {
            self.apply(Snapshot::default());
            return true;
        }
        changed
    }

    /// Queue one revert for the chip on screen. Only a live chip that still
    /// offers Revert accepts it, once, until the web shows another status.
    pub(crate) fn revert_click(&mut self, now: u64) -> bool {
        let Some(edit) = self.snapshot.edit_live(now) else {
            return false;
        };
        if !self.target
            || !edit.ready()
            || self.revert_sent == Some(edit.id)
            || self.actions.len() >= capsules::ACTION_LIMIT
        {
            return false;
        }
        let id = edit.id;
        self.revert_sent = Some(id);
        self.actions.push(json!({
            "session": self.snapshot.session,
            "state": self.snapshot.state,
            "action": "revert",
            "value": null,
            "edit": id,
        }));
        true
    }

    /// Clickable rectangles as (width, top, height), centered horizontally and
    /// measured from the panel top: the capsule, then the chip below it.
    pub(crate) fn hit_rects(&self, now: u64) -> Vec<[f64; 3]> {
        let mut rects = Vec::new();
        if !self.target {
            return rects;
        }
        let mut top = 8.;
        if self.snapshot.state != "extras" {
            let (width, height) = capsules::size(&self.snapshot);
            if capsules::interactive(&self.snapshot) {
                rects.push([width, top, height]);
            }
            top += height + GAP;
        }
        if self.snapshot.edit_live(now).is_some() {
            rects.push([CHIP.0, top, CHIP.1]);
        }
        rects
    }

    pub(crate) fn render_extras(
        &self,
        opacity: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let now = capsules::now_ms();
        let edit = self.snapshot.edit_live(now);
        let glint = self.snapshot.glint_live(now);
        if edit.is_none() && glint.is_none() {
            return None;
        }
        let t = crate::theme::current();
        let first = self.snapshot.state == "extras";
        let mut column = div().flex().flex_col().items_center();
        if let Some(edit) = edit {
            let ready = edit.ready();
            column = column.child(
                div()
                    .id("native-edit-chip")
                    .debug_selector(|| "native-edit-chip".into())
                    .mt(px(if first { 0. } else { GAP as f32 }))
                    .w(px(CHIP.0 as f32))
                    .h(px(CHIP.1 as f32))
                    .px(px(11.))
                    .rounded(px(12.))
                    .bg(t.surface_raised)
                    .border_1()
                    .border_color(t.border)
                    .text_size(px(10.5))
                    .font_family(t.font_ui)
                    .font_weight(gpui::FontWeight::LIGHT)
                    .text_color(if ready { t.text } else { t.text_muted })
                    .flex()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .opacity(opacity)
                    .when(ready, |d| d.cursor_pointer().hover(|s| s.bg(t.hover)))
                    .on_click(cx.listener(|pill, _, _, cx| {
                        pill.revert_click(capsules::now_ms());
                        cx.notify();
                    }))
                    .child(div().truncate().child(edit.label())),
            );
        }
        if let Some(glint) = glint {
            if glint.phase(now) == 1 {
                window.request_animation_frame();
            }
            let tone = match glint.tone.as_str() {
                "error" => t.danger,
                "warning" => t.warning,
                "success" => t.success,
                _ => t.text_secondary,
            };
            column = column.child(
                div()
                    .debug_selector(|| "native-dock-glint".into())
                    .mt(px(if first && edit.is_none() {
                        0.
                    } else {
                        GAP as f32
                    }))
                    .px(px(10.))
                    .py(px(3.))
                    .rounded(px(9.))
                    .bg(t.surface_raised)
                    .border_1()
                    .border_color(if glint.tone == "progress" {
                        t.border
                    } else {
                        tone
                    })
                    .text_size(px(9.5))
                    .font_family(t.font_ui)
                    .font_weight(gpui::FontWeight::LIGHT)
                    .text_color(tone)
                    .whitespace_nowrap()
                    .opacity(opacity * glint.opacity(now))
                    .child(
                        glint
                            .text
                            .to_uppercase()
                            .chars()
                            .take(120)
                            .collect::<String>(),
                    ),
            );
        }
        Some(column.into_any_element())
    }
}
