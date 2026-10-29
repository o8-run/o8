//! Left navigation rail, the native counterpart of CompactNavigationRail.tsx.
//! Surfaces keep their own entries through `Registration::nav`; the rail only
//! lays them out and adds the shell-level destinations.
use super::*;
use crate::icon::Tip;
use crate::theme::current as theme;
use gpui::{AnyElement, Div, Image, ImageFormat, ObjectFit, Rgba, SharedString, Stateful, img};
use serde_json::Value;
use std::sync::{Arc, Mutex, Once, OnceLock};

// NAVIGATION_RAIL_WIDTH and the 44px rail target in shell-geometry.ts.
pub(super) const WIDTH: f32 = 60.;
const TARGET: f32 = 44.;
const ICON: f32 = 19.;

#[derive(Clone, Copy)]
pub(super) enum Icon {
    Play,
    Gauge,
    Terminal,
    Canvas,
    Plugins,
    Folder,
    PullRequest,
    Setup,
}

impl Icon {
    // Lucide paths used by the desktop rail, embedded for native use.
    fn path(self) -> &'static str {
        match self {
            Self::Play => {
                "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"
            }
            Self::Gauge => "m12 14 4-4 M3.34 19a10 10 0 1 1 17.32 0",
            Self::Terminal => "m4 17 6-6-6-6 M12 19h8",
            Self::Canvas => {
                "M8 3h8a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V8a5 5 0 0 1 5-5Z M9 9h.01 M15 9h.01 M9 15h.01 M15 15h.01"
            }
            Self::Plugins => {
                "M8 3H5a2 2 0 0 0-2 2v3a3 3 0 1 1 0 6v3a2 2 0 0 0 2 2h3a3 3 0 1 1 6 0h3a2 2 0 0 0 2-2v-3a3 3 0 1 0 0-6V5a2 2 0 0 0-2-2h-3a3 3 0 1 0-6 0Z"
            }
            Self::Folder => {
                "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
            }
            Self::PullRequest => {
                "M18 15a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M6 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M13 6h3a2 2 0 0 1 2 2v7 M6 9v12"
            }
            Self::Setup => {
                "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"
            }
        }
    }
}

fn glyph(icon: Icon, color: Rgba) -> impl IntoElement {
    crate::icon::stroke(icon.path(), color, ICON, 1.8)
}

/// One rail target. Callers attach the click handler; `active` marks the open destination.
pub(super) fn button(
    id: &'static str,
    icon: Icon,
    label: &'static str,
    active: bool,
) -> Stateful<Div> {
    target(id)
        .tooltip(move |_, cx| cx.new(|_| Tip(label.into())).into())
        .when(active, |view| view.bg(theme().hover))
        .child(glyph(
            icon,
            if active {
                theme().text
            } else {
                theme().text_secondary
            },
        ))
}

fn target(id: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .size(px(TARGET))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(10.))
        .cursor_pointer()
        .hover(|view| view.bg(theme().hover))
}

// Weekly ratios behind the rail gauge, read like useRuntimeUsage and weeklyUsage
// in CompactNavigationRail.tsx.
#[derive(Clone, Copy, Default)]
struct Usage {
    codex: Option<f32>,
    claude: Option<f32>,
    highest: Option<f32>,
}
static USAGE: Mutex<Usage> = Mutex::new(Usage {
    codex: None,
    claude: None,
    highest: None,
});

fn weekly(snapshot: &Value, runtime: &str) -> Option<f32> {
    let identity = snapshot["identities"].as_array().and_then(|all| {
        all.iter()
            .find(|i| i["runtime"] == runtime && i["selected"] == true)
    });
    snapshot["capacities"]
        .as_array()?
        .iter()
        .filter(|c| {
            c["runtime"] == runtime && c["status"] == "available" && c["confidence"] == "exact"
        })
        .filter(|c| identity.is_none_or(|i| c["identityId"] == i["id"]))
        .flat_map(|c| c["buckets"].as_array().cloned().unwrap_or_default())
        .filter(|b| b["label"] == "Weekly")
        .filter_map(|b| b["usedRatio"].as_f64())
        .map(|ratio| ratio.clamp(0., 1.) as f32)
        .reduce(f32::max)
}

fn read_usage(snapshot: &Value) -> Usage {
    let highest = snapshot["capacities"].as_array().and_then(|all| {
        all.iter()
            .filter(|c| c["status"] == "available")
            .flat_map(|c| c["buckets"].as_array().cloned().unwrap_or_default())
            .filter_map(|b| b["usedRatio"].as_f64())
            .map(|ratio| ratio as f32)
            .reduce(f32::max)
    });
    Usage {
        codex: weekly(snapshot, "codex"),
        claude: weekly(snapshot, "claude-code"),
        highest,
    }
}

fn watch_usage(client: &Client) {
    // Fixture servers record every request, so tests never start the poll.
    if cfg!(test) {
        return;
    }
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let client = client.clone();
        std::thread::spawn(move || {
            loop {
                if let Ok(snapshot) = client.get::<Value>("/api/runtime/capacity", &[]) {
                    *USAGE.lock().unwrap() = read_usage(&snapshot);
                }
                std::thread::sleep(Duration::from_secs(60));
            }
        });
    });
}

fn percent(ratio: Option<f32>) -> String {
    ratio.map_or("not reported".into(), |r| {
        format!("{}% used", (r * 100.).round())
    })
}

fn gauge() -> Stateful<Div> {
    let usage = *USAGE.lock().unwrap();
    let label: SharedString = format!(
        "Weekly usage: Codex {}, Claude {}",
        percent(usage.codex),
        percent(usage.claude)
    )
    .into();
    let meter = |ratio: Option<f32>, color: Rgba, bottom: f32| {
        div()
            .absolute()
            .left(px(16.))
            .bottom(px(bottom))
            .w(px(12.))
            .h(px(2.))
            .rounded(px(2.))
            .overflow_hidden()
            .bg(theme().border)
            .children(ratio.map(|r| div().h_full().w(px(12. * r)).bg(color)))
    };
    target("rail-usage")
        .relative()
        .tooltip(move |_, cx| cx.new(|_| Tip(label.clone())).into())
        .child(glyph(
            Icon::Gauge,
            if usage.highest.is_some_and(|r| r >= 0.8) {
                crate::theme::brand_orange()
            } else {
                theme().text_muted
            },
        ))
        .child(meter(usage.codex, theme().accent, 6.))
        .child(meter(usage.claude, crate::theme::brand_orange(), 2.))
}

fn divider() -> Div {
    div()
        .w(px(27.))
        .h(px(1.))
        .my(px(6.))
        .flex_shrink_0()
        .bg(theme().border)
}

fn brand() -> impl IntoElement {
    static LOGO: OnceLock<Arc<Image>> = OnceLock::new();
    let logo = LOGO.get_or_init(|| {
        Arc::new(Image::from_bytes(
            ImageFormat::Png,
            include_bytes!("surfaces/sidebar/project_identity.png").to_vec(),
        ))
    });
    img(logo.clone())
        .size(px(24.))
        .object_fit(ObjectFit::Contain)
}

impl Shell {
    pub(super) fn render_rail(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let top = registrations()
            .iter()
            .flat_map(|r| (r.nav)(self, NavPosition::BeforeWorkspaces, cx))
            .collect::<Vec<_>>();
        let bottom = registrations()
            .iter()
            .flat_map(|r| (r.nav)(self, NavPosition::AfterWorkspaces, cx))
            .collect::<Vec<_>>();
        watch_usage(&self.client);
        let active = self.active();
        let tab = |id: &'static str,
                   icon: Icon,
                   label: &'static str,
                   tab: Tab,
                   command: fn() -> Command| {
            button(id, icon, label, active.as_ref() == Some(&tab)).on_click(cx.listener(
                move |this, _, window, cx| {
                    this.capture(window, cx);
                    this.execute(command(), window, cx);
                },
            ))
        };
        let projects_open = self.surfaces.projects.open;
        div()
            .id("shell-rail")
            .absolute()
            .top(px(crate::theme::GEOMETRY.header))
            .bottom_0()
            .left_0()
            .w(px(WIDTH))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .items_center()
            .py(px(8.))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|_, _, window, _| window.prevent_default()),
            )
            .child(
                // Home returns to the workspace, which is what "Back to workspace" did.
                target(if projects_open {
                    "shell-workspace"
                } else {
                    "shell-home"
                })
                .tooltip(|_, cx| cx.new(|_| Tip("o8 — Home".into())).into())
                .child(brand())
                .on_click(cx.listener(|this, _, window, cx| {
                    this.surfaces.projects.open = false;
                    this.restore_focus(window, cx);
                    cx.notify();
                })),
            )
            .child(
                // Opens the workspace orchestrator with its composer focused.
                button("rail-orchestrator", Icon::Play, "Run orchestrator", false).on_click(
                    cx.listener(|this, _, window, cx| {
                        this.capture(window, cx);
                        match this.workspace_sessions().first().map(|s| s.id.clone()) {
                            Some(id) => this.execute(Command::Message(id), window, cx),
                            None => this.execute(Command::Setup, window, cx),
                        }
                    }),
                ),
            )
            .child(tab(
                "rail-terminal",
                Icon::Terminal,
                "Run terminal",
                Tab::Terminal,
                || Command::Terminal,
            ))
            .child(tab("rail-grid", Icon::Canvas, "Grid", Tab::Grid, || {
                Command::Grid
            }))
            .child(divider())
            .children(top)
            .child(divider())
            .child(div().flex_1().min_h_0())
            .child(gauge())
            .children(features::rail(self, window, cx))
            .children(bottom)
            .into_any_element()
    }
}
