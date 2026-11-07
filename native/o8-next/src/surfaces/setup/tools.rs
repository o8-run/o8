//! The desktop's agent and tools step (OnboardingDispatchStep.tsx), with its
//! readiness cards (AgentReadiness.tsx), the tool setup panel
//! (OnboardingToolsPanel.tsx), provider marks (RuntimeIdentity.tsx) and the
//! slow-scan line (useToolScanStatus.ts). Signing in to a tool stays outside
//! setup: a tool that needs it shows its readiness and setup instructions.
use super::look::{self, Look};
use super::{Action, Setup, Snapshot, Step, primary, quiet};
use crate::theme::current as theme;
use gpui::{
    AnyElement, Context, Div, FontWeight, Image, ImageFormat, ObjectFit, SharedString, div, img,
    prelude::*, px, relative,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, OnceLock},
};

/// Which part of the step shows: the agent choices, the customize panel or
/// the tool setup panel. None until the person picks one, as on the desktop.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Panel {
    Choose,
    Customize,
    Tools,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct BuiltIn {
    pub backend: String,
    pub plan_detail: String,
}
/// One `dispatchableRuntimes` row from operator defaults.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Runtime {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub installed: bool,
    pub unavailable_reason: Option<String>,
    pub detail: String,
    pub fix: String,
    pub built_in: Option<BuiltIn>,
}

/// The desktop's RUNTIME_INSTALL_INFO, copied verbatim and pinned by
/// `src/lib/setup/native-runtime-install.test.ts`.
#[derive(Deserialize)]
pub(super) struct Install {
    pub command: Option<String>,
    pub link: Option<String>,
    pub hint: String,
}
static INSTALL: LazyLock<HashMap<String, Install>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("runtime-install.json")).unwrap_or_default()
});
pub(super) fn install(id: &str) -> Option<&'static Install> {
    INSTALL.get(id)
}

impl Snapshot {
    pub(super) fn inventory(&self) -> Vec<Runtime> {
        serde_json::from_value(self.setup["dispatchableRuntimes"].clone()).unwrap_or_default()
    }
    /// Whether the environment or a subscription profile owns a setting.
    fn locked(&self, key: &str) -> bool {
        matches!(self.setup["sources"][key].as_str(), Some("env" | "profile"))
    }
    /// A setting someone chose, rather than the default.
    fn explicit(&self, key: &str) -> bool {
        self.setup["sources"][key]
            .as_str()
            .is_some_and(|source| source != "default")
    }
}

/// The bundled agent, never the separately installed Pi CLI.
pub(super) fn built_in(inventory: &[Runtime]) -> Option<&Runtime> {
    inventory
        .iter()
        .find(|item| item.built_in.is_some() && item.id != "pi")
}
/// The runtime that runs a lead backend.
pub(super) fn runtime_for_lead(backend: &str, inventory: &[Runtime]) -> Option<String> {
    if let Some(item) = built_in(inventory)
        && item.built_in.as_ref().is_some_and(|b| b.backend == backend)
    {
        return Some(item.id.clone());
    }
    match backend {
        "claude" | "fable" => Some("claude-code".into()),
        "codex" | "opencode" | "muse" | "pi" => Some(backend.into()),
        _ => None,
    }
}
fn available(inventory: &[Runtime], id: &str) -> bool {
    inventory.iter().any(|item| item.id == id && item.available)
}
/// The backend a readiness card selects.
fn card_backend(item: &Runtime) -> String {
    match &item.built_in {
        Some(built_in) => built_in.backend.clone(),
        None if item.id == "claude-code" => "claude".into(),
        None => item.id.clone(),
    }
}
pub(super) fn readiness(item: &Runtime) -> &'static str {
    if item.available {
        return "Ready";
    }
    if item.built_in.is_some() {
        return "Unavailable";
    }
    match item.unavailable_reason.as_deref() {
        Some("not_installed") => "Not installed",
        Some("needs_auth") => "Sign-in needed",
        Some("needs_restart") => "Restart needed",
        _ => "Needs attention",
    }
}
/// Tools worth showing: ready, installed, built in, one step from ready, or chosen.
fn visible<'a>(inventory: &'a [Runtime], selected: &[String]) -> Vec<&'a Runtime> {
    inventory
        .iter()
        .filter(|item| {
            item.available
                || item.installed
                || item.built_in.is_some()
                || matches!(
                    item.unavailable_reason.as_deref(),
                    Some("needs_auth" | "needs_restart")
                )
                || selected.contains(&item.id)
        })
        .collect()
}
pub(super) fn lead_label(backend: &str, inventory: &[Runtime]) -> String {
    if let Some(item) = inventory
        .iter()
        .find(|item| item.built_in.as_ref().is_some_and(|b| b.backend == backend))
    {
        return item.label.clone();
    }
    match backend {
        "codex" => "Codex",
        "claude" => "Claude Code",
        "fable" => "Fable",
        "opencode" => "OpenCode · experimental",
        "o8" => "o8",
        "auto" => "Saved automatic routing",
        other => other,
    }
    .to_owned()
}
/// The detection line under the cards while tools are checked.
pub(super) fn scan_status(slow: bool) -> &'static str {
    if slow {
        "Still checking installed tools and local sign-in. You can choose a project while this \
         finishes."
    } else {
        "Checking your coding tools…"
    }
}

const GEMINI: &str =
    "M12 1.5c.4 4.9 4.1 8.6 9 9-4.9.4-8.6 4.1-9 9-.4-4.9-4.1-8.6-9-9 4.9-.4 8.6-4.1 9-9z";
const OPENCODE: &str = "M8 6 3 12l5 6M16 6l5 6-5 6M14 5 10 19";
const CHECK: &str = "M20 6L9 17l-5-5";
const PLUS: &str = "M12 5v14M5 12h14";
const SLIDERS: &str = "M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4";
const REFRESH: &str = "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5";
const EXTERNAL: &str =
    "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6";
const CHEVRON: &str = "m6 9 6 6 6-6";

/// A tool's mark in its 32 px tile, as on the desktop.
pub(super) fn identity(id: &str, built_in: bool) -> Div {
    static CODEX: OnceLock<Arc<Image>> = OnceLock::new();
    static CLAUDE: OnceLock<Arc<Image>> = OnceLock::new();
    let mark: AnyElement = if built_in {
        div()
            .text_size(px(24.))
            .font_weight(FontWeight::LIGHT)
            .text_color(theme().text)
            .child("π")
            .into_any_element()
    } else {
        match id {
            "codex" => img(CODEX
                .get_or_init(|| {
                    Arc::new(Image::from_bytes(
                        ImageFormat::Webp,
                        include_bytes!("codex.webp").to_vec(),
                    ))
                })
                .clone())
            .size(px(32.))
            .object_fit(ObjectFit::Contain)
            .into_any_element(),
            "claude-code" => img(CLAUDE
                .get_or_init(|| {
                    Arc::new(Image::from_bytes(
                        ImageFormat::Png,
                        include_bytes!("claude.png").to_vec(),
                    ))
                })
                .clone())
            .size(px(24.))
            .object_fit(ObjectFit::Contain)
            .into_any_element(),
            "gemini" | "antigravity" => {
                crate::icon::fill(GEMINI, crate::theme::gemini_mark(), 24.).into_any_element()
            }
            "opencode" => crate::icon::stroke(OPENCODE, crate::theme::opencode_mark(), 24., 2.4)
                .into_any_element(),
            other => div()
                .text_size(px(11.))
                .text_color(theme().text_secondary)
                .child(other.chars().take(2).collect::<String>().to_uppercase())
                .into_any_element(),
        }
    };
    div()
        .size(px(32.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(8.))
        .overflow_hidden()
        .bg(if id == "claude-code" && !built_in {
            gpui::white().into()
        } else {
            theme().surface_raised
        })
        .child(mark)
}

/// AgentReadiness: a card per tool with its readiness. With `select`, the
/// cards choose the lead and the chosen one shows it.
pub(super) fn readiness_cards(
    items: &[&Runtime],
    selected: Option<&str>,
    select: Option<&dyn Fn(&Runtime) -> gpui::Stateful<Div>>,
) -> Div {
    div()
        .debug_selector(|| "setup-agent-readiness".into())
        .flex()
        .flex_col()
        .gap(px(8.))
        .children(items.iter().map(|item| {
            let chosen = select.is_some() && selected == Some(item.id.as_str());
            let status = readiness(item);
            let detail = if item.available {
                let plain = item.detail.trim().trim_end_matches('.').to_lowercase();
                if plain == "ready" || plain == "ready to code" {
                    "Available on this computer".to_owned()
                } else {
                    item.detail.clone()
                }
            } else if item.fix.is_empty() {
                item.detail.clone()
            } else {
                item.fix.clone()
            };
            let tone = if item.available {
                theme().success
            } else {
                theme().text_muted
            };
            let content = |v: gpui::Stateful<Div>| {
                v.w_full()
                    .min_h(px(76.))
                    .p(px(16.))
                    .gap(px(16.))
                    .rounded(px(10.))
                    .border_1()
                    .border_color(if chosen {
                        theme().accent
                    } else {
                        theme().border
                    })
                    .bg(if chosen {
                        theme().surface_raised
                    } else {
                        theme().background
                    })
                    .text_color(theme().text)
                    .child(identity(&item.id, item.built_in.is_some()))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(div().text_size(px(13.5)).child(item.label.clone()))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(relative(1.5))
                                    .text_color(theme().text_secondary)
                                    .child(detail),
                            )
                            .when_some(item.built_in.as_ref(), |v, built_in| {
                                v.child(
                                    div()
                                        .text_size(px(11.))
                                        .line_height(relative(1.5))
                                        .text_color(theme().text_muted)
                                        .child(built_in.plan_detail.clone()),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .text_size(px(11.))
                            .text_color(tone)
                            .child(div().size(px(6.)).rounded_full().bg(tone))
                            .child(status)
                            .when(chosen, |v| {
                                v.child(
                                    div()
                                        .debug_selector(|| "setup-agent-selected".into())
                                        .text_color(theme().text_secondary)
                                        .child("· Selected"),
                                )
                            }),
                    )
            };
            match select {
                Some(select) => content(select(item)).into_any_element(),
                None => content(
                    div()
                        .id(SharedString::from(format!("setup-ready-{}", item.id)))
                        .debug_selector({
                            let id = format!("setup-ready-{}", item.id);
                            move || id.clone()
                        })
                        .flex()
                        .items_center()
                        .font_weight(FontWeight::LIGHT),
                )
                .into_any_element(),
            }
        }))
}

/// RuntimeInventoryRow: a worker choice with its check box.
fn worker_row(
    item: &Runtime,
    chosen: bool,
    is_default: bool,
    enabled: bool,
) -> gpui::Stateful<Div> {
    let selectable = item.available;
    look::button(
        &format!("setup-worker-{}", item.id),
        "",
        enabled && (selectable || chosen),
        Look::Bordered,
    )
    .w_full()
    .min_h(px(58.))
    .py(px(9.))
    .px(px(12.))
    .justify_between()
    .border_color(if chosen {
        theme().accent
    } else {
        theme().border
    })
    .bg(if chosen {
        theme().surface_raised
    } else {
        theme().background
    })
    .when(!selectable, |v| v.opacity(0.52))
    .child(identity(&item.id, item.built_in.is_some()))
    .child(
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(3.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(7.))
                    .child(div().text_size(px(13.5)).child(item.label.clone()))
                    .when(is_default, |v| {
                        v.child(
                            div()
                                .text_size(px(9.))
                                .text_color(theme().accent)
                                .child("DEFAULT WORKER"),
                        )
                    }),
            )
            .child(
                div()
                    .text_size(px(10.5))
                    .line_height(relative(1.35))
                    .text_color(theme().text_muted)
                    .child(if selectable || item.fix.is_empty() {
                        item.detail.clone()
                    } else {
                        item.fix.clone()
                    }),
            ),
    )
    .child(
        div()
            .debug_selector({
                let id = format!("setup-worker-{}-box", item.id);
                move || id.clone()
            })
            .size(px(24.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(7.))
            .border_1()
            .border_color(if chosen {
                theme().accent
            } else {
                theme().border
            })
            .when(chosen, |v| {
                v.bg(theme().accent)
                    .child(crate::icon::stroke(CHECK, theme().background, 14., 2.2))
            }),
    )
}

impl Setup {
    /// The lead backends offered, in the desktop's order.
    fn lead_options(&self, inventory: &[Runtime], snapshot: &Snapshot) -> Vec<String> {
        let customize = self.panel == Some(Panel::Customize);
        let mut options: Vec<String> = ["codex", "claude"]
            .iter()
            .chain(if customize {
                ["fable", "opencode", "o8"].iter()
            } else {
                [].iter()
            })
            .filter(|id| {
                **id == "o8"
                    || runtime_for_lead(id, &[]).is_some_and(|rt| available(inventory, &rt))
            })
            .map(|id| (*id).to_owned())
            .collect();
        if let Some(item) = built_in(inventory).filter(|item| item.available) {
            let backend = card_backend(item);
            if !options.contains(&backend) {
                options.insert(0, backend);
            }
        }
        let preserved = snapshot.setup["setupRecommendation"]["preserved"] == true;
        if (preserved || self.choice_made)
            && !options.contains(&self.backend)
            && !self.backend.is_empty()
        {
            options.push(self.backend.clone());
        }
        options
    }
    /// changeLead: a new lead also becomes the worker while the worker
    /// choice is still the default.
    pub(super) fn change_lead(&mut self, backend: String, cx: &mut Context<Self>) {
        let Some(snapshot) = self.snapshot.clone() else {
            return;
        };
        let inventory = snapshot.inventory();
        self.choice_made = true;
        if self.backend != backend {
            self.model.update(cx, |model, cx| model.clear(cx));
        }
        self.backend = backend;
        let preserved = snapshot.setup["setupRecommendation"]["preserved"] == true;
        if !preserved
            && !snapshot.locked("defaultDispatchRuntime")
            && self.panel != Some(Panel::Customize)
            && !snapshot.explicit("defaultDispatchRuntime")
            && !snapshot.explicit("workerRuntimes")
            && let Some(runtime) = runtime_for_lead(&self.backend, &inventory)
            && available(&inventory, &runtime)
        {
            self.workers = vec![runtime];
        }
        self.lead_menu = false;
        self.revision += 1;
        cx.notify();
    }
/// Set up later saves nothing, so the unsaved choice goes back to the
    /// server's recommendation, which home and Change show.
    fn set_up_later(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if let Some(snapshot) = &self.snapshot {
            let (backend, workers) = snapshot.recommendation();
            if self.backend != backend {
                self.model.update(cx, |model, cx| model.clear(cx));
            }
            (self.backend, self.workers) = (backend, workers);
        }
        self.choice_made = false;
        self.navigate(Step::Projects, cx);
    }
    fn set_panel(&mut self, panel: Panel, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.panel = Some(panel);
        self.lead_menu = false;
        self.copied = None;
        self.revision += 1;
        cx.notify();
    }

    /// The agent and tools step.
    pub(super) fn tools_page(&self, cx: &mut Context<Self>) -> Div {
        let snapshot = self.snapshot.clone();
        let inventory = snapshot
            .as_ref()
            .map(Snapshot::inventory)
            .unwrap_or_default();
        let loading = self.scanning;
        let saving = self.saving;
        let customize = self.panel == Some(Panel::Customize);
        let options = snapshot
            .as_ref()
            .map(|s| self.lead_options(&inventory, s))
            .unwrap_or_default();
        let built = built_in(&inventory);
        let needs_connection = snapshot.is_some() && options.is_empty() && built.is_none();
        let show_tools =
            self.panel == Some(Panel::Tools) || (needs_connection && self.panel.is_none());
        let lead = runtime_for_lead(&self.backend, &inventory);
        let label = lead_label(&self.backend, &inventory);
        let recommendation = snapshot
            .as_ref()
            .map(|s| s.setup["setupRecommendation"].clone())
            .unwrap_or_default();
        let same_lead = recommendation["backend"] == self.backend.as_str();
        let preserved = recommendation["preserved"] == true;
        let lead_ready = match &lead {
            Some(runtime) => available(&inventory, runtime),
            None => self.backend == "o8" || (same_lead && preserved),
        };
        let ready_to_save = snapshot.is_some()
            && !self.scan_failed
            && lead_ready
            && !self.workers.is_empty()
            && self.workers.iter().all(|id| available(&inventory, id));
        let locked = snapshot
            .as_ref()
            .is_some_and(|s| s.locked("orchestratorBackend"));
        let workers_locked = snapshot
            .as_ref()
            .is_some_and(|s| s.locked("defaultDispatchRuntime"));
        let consent = snapshot
            .as_ref()
            .is_some_and(|s| s.setup["values"]["telemetryConsentAnswered"] == true);
        let project = self.project.as_ref().map(|p| p.name.clone());
        let heading = if show_tools {
            if needs_connection {
                "Connect a coding tool"
            } else {
                "Add coding tools"
            }
        } else if customize {
            "Customize your setup"
        } else {
            "Choose your agent"
        };
        let intro = if show_tools {
            "Install or sign in to a tool, then refresh to check it. Your selected setup stays yours."
        } else if customize {
            "Choose the lead and workers for this project. Save when your setup is ready."
        } else {
            "Start with an agent. You can add coding tools and adjust your setup later."
        };
        let next = if loading {
            "Checking tools before you continue.".to_owned()
        } else if self.scan_failed {
            "Check your tools again to continue.".to_owned()
        } else if ready_to_save {
            match &project {
                Some(name) if consent => format!("Next: open {name} with {label}."),
                Some(_) => {
                    "Next: choose your privacy preferences, then open your workspace.".into()
                }
                None => "Next: save this setup and return to your projects.".into(),
            }
        } else {
            "Finish connecting your selected tools, then check them here.".into()
        };
        let use_label = if saving {
            "Saving setup…".to_owned()
        } else {
            match &project {
                Some(name) => format!("Continue to {name}"),
                None => "Use this setup".into(),
            }
        };

        // The scrolling part of the page, above the docked action row.
        let mut scroll = div().w_full().flex().flex_col().gap(px(16.)).child(
            div()
                .debug_selector(move || {
                    if needs_connection && show_tools {
                        "setup-connect-tool".into()
                    } else {
                        "setup-tools-heading".into()
                    }
                })
                .child(look::title(heading))
                .child(
                div()
                    .mt(px(12.))
                    .text_size(px(13.))
                    .font_weight(FontWeight::LIGHT)
                    .line_height(relative(1.6))
                    .text_color(theme().text_secondary)
                    .child(intro),
            ),
        );
        if show_tools {
            scroll =
                scroll.child(self.tools_panel(&inventory, needs_connection, loading, saving, cx));
        } else {
            if !customize {
                // The bundled agent first, then the primary tools and the lead.
                let common: Vec<&Runtime> = if built.is_some_and(|b| b.available) {
                    visible(&inventory, lead.as_slice())
                } else {
                    inventory.iter().collect()
                }
                .into_iter()
                .filter(|item| {
                    item.id == "codex"
                        || item.id == "claude-code"
                        || Some(&item.id) == lead.as_ref()
                })
                .collect();
                let choices: Vec<&Runtime> = built
                    .into_iter()
                    .chain(
                        common
                            .into_iter()
                            .filter(|item| Some(item.id.as_str()) != built.map(|b| b.id.as_str())),
                    )
                    .collect();
                let entity = cx.entity().downgrade();
                let select = move |item: &Runtime| {
                    let backend = card_backend(item);
                    let enabled = item.available && !loading && !saving && !locked;
                    let entity = entity.clone();
                    look::button(
                        &format!("setup-agent-{}", item.id),
                        "",
                        enabled,
                        Look::Quiet,
                    )
                    .on_click(move |_, _, cx| {
                        if enabled {
                            let backend = backend.clone();
                            let _ = entity.update(cx, |this, cx| this.change_lead(backend, cx));
                        }
                    })
                };
                scroll = scroll.child(readiness_cards(&choices, lead.as_deref(), Some(&select)));
                scroll = scroll.child(
                    div()
                        .debug_selector(|| "setup-scan-status".into())
                        .text_size(px(12.))
                        .line_height(relative(1.5))
                        .text_color(theme().text_secondary)
                        .when(loading, |v| v.child(scan_status(self.scan_slow)))
                        .when(!loading, |v| {
                            v.child(format!("Selected agent: {label}."))
                                .when(same_lead, |v| {
                                    v.child(div().mt(px(4.)).child(
                                        recommendation["reason"].as_str().unwrap_or("").to_owned(),
                                    ))
                                })
                        }),
                );
            }
            scroll = scroll.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        look::button("setup-customize", "", !loading && !saving, Look::Bordered)
                            .gap(px(8.))
                            .child(crate::icon::stroke(SLIDERS, theme().text, 14., 1.6))
                            .child(if customize {
                                "Done customizing"
                            } else {
                                "Customize setup"
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.set_panel(
                                    if customize {
                                        Panel::Choose
                                    } else {
                                        Panel::Customize
                                    },
                                    cx,
                                )
                            })),
                    )
                    .child(
                        look::button("setup-add-tools", "", !loading && !saving, Look::Bordered)
                            .gap(px(8.))
                            .child(crate::icon::stroke(PLUS, theme().text, 14., 1.6))
                            .child("Add coding tools")
                            .on_click(
                                cx.listener(|this, _, _, cx| this.set_panel(Panel::Tools, cx)),
                            ),
                    ),
            );
            if customize {
                scroll = scroll.child(self.customize_panel(
                    &inventory,
                    &options,
                    &recommendation,
                    locked,
                    workers_locked,
                    loading,
                    saving,
                    cx,
                ));
            }
            // Native setup opens a first conversation, which needs a model.
            if same_lead && snapshot.as_ref().is_some_and(|s| s.model("").is_none()) {
                scroll =
                    scroll
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(theme().text_secondary)
                                .child("Choose a model ID for this runtime to continue."),
                        )
                        .child(
                            div()
                                .id("setup-model-input")
                                .debug_selector(|| "setup-model-input".into())
                                .on_click(cx.listener(|s, _, window, cx| {
                                    s.model.read(cx).focus.focus(window)
                                }))
                                .child(self.model.clone()),
                        );
            }
        }
        let hint = |text: &'static str| {
            div()
                .text_size(px(12.))
                .text_color(theme().text_muted)
                .child(text)
        };
        scroll = scroll
            .when(!loading && !lead_ready && !needs_connection, |v| {
                v.child(hint(
                    "Connect a primary lead, or customize to choose a supported alternative.",
                ))
            })
            .when(
                !loading && !ready_to_save && !self.workers.is_empty(),
                |v| {
                    v.child(hint(
                    "Some selected tools need attention. Add coding tools or customize your setup.",
                ))
                },
            )
            .when_some(self.error.clone(), |v, error| {
                v.child(look::feedback(
                    "setup-error",
                    error,
                    "Your selections are still here. Try saving again when you’re ready.",
                    None,
                ))
            })
            .when(!show_tools, |v| {
                v.child(
                    div()
                        .text_size(px(10.5))
                        .line_height(relative(1.4))
                        .text_color(theme().text_faint)
                        .child(format!(
                            "{}Messaging and other optional features can be connected later.",
                            if lead.is_some() && lead.as_deref() != built.map(|b| b.id.as_str()) {
                                "Recommendations use session file activity from the past seven \
                                 days. Conversation contents stay unread. "
                            } else {
                                ""
                            }
                        )),
                )
            });

        let mut left = vec![];
        if show_tools {
            left.push(
                quiet("setup-back-choices", "Back to agent choices", !saving)
                    .text_size(px(12.))
                    .on_click(cx.listener(|this, _, _, cx| this.set_panel(Panel::Choose, cx)))
                    .into_any_element(),
            );
        }
        left.push(
            quiet("setup-later", "Set up later", !saving)
                .text_size(px(12.))
                .text_color(theme().text_faint)
                .on_click(cx.listener(|this, _, _, cx| this.set_up_later(cx)))
                .into_any_element(),
        );
        let mut right = vec![];
        if show_tools {
            right.push(
                look::button(
                    "setup-refresh-tools",
                    "",
                    !loading && !saving,
                    Look::Bordered,
                )
                .gap(px(8.))
                .child(crate::icon::stroke(REFRESH, theme().text, 14., 1.6))
                .child(if loading {
                    "Checking tools…"
                } else {
                    "Refresh tools"
                })
                .on_click(cx.listener(|this, _, _, cx| this.act(Action::Load(true), cx)))
                .into_any_element(),
            );
        }
        right.push(
            primary("setup-use", use_label, !loading && !saving && ready_to_save)
                .on_click(cx.listener(|this, _, _, cx| this.act(Action::Use, cx)))
                .into_any_element(),
        );
        div()
            .debug_selector(|| "setup-tools".into())
            .w_full()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .id("setup-tools-scroll")
                    .w_full()
                    // A column, so the page stretches across the frame.
                    .flex()
                    .flex_col()
                    .debug_selector(|| "setup-tools-scroll".into())
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(scroll),
            )
            .child(
                div()
                    .flex_none()
                    .mt(px(12.))
                    .pt(px(12.))
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .border_t_1()
                    .border_color(theme().border)
                    .child(
                        div()
                            .debug_selector(|| "setup-next-action".into())
                            .w_full()
                            .text_size(px(12.))
                            .line_height(relative(1.5))
                            .text_color(theme().text_secondary)
                            .child(next),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(4.))
                            .children(left),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .justify_end()
                            .gap(px(8.))
                            .children(right),
                    ),
            )
    }

    #[allow(clippy::too_many_arguments)]
    fn customize_panel(
        &self,
        inventory: &[Runtime],
        options: &[String],
        recommendation: &serde_json::Value,
        locked: bool,
        workers_locked: bool,
        loading: bool,
        saving: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let built = built_in(inventory);
        let lead = runtime_for_lead(&self.backend, inventory);
        let same_lead = recommendation["backend"] == self.backend.as_str();
        let lead_note = if lead.is_some() && lead.as_deref() == built.map(|b| b.id.as_str()) {
            built
                .and_then(|b| b.built_in.as_ref())
                .map(|b| b.plan_detail.clone())
                .unwrap_or_default()
        } else {
            match recommendation["leadModel"]
                .as_str()
                .filter(|m| same_lead && !m.is_empty())
            {
                Some(model) => crate::composer::controls::model_label(model),
                None => "Uses the configured model".into(),
            }
        };
        let first_same = recommendation["workerRuntimes"][0]
            == self.workers.first().map(String::as_str).unwrap_or("");
        let worker_note =
            if self.workers.first().map(String::as_str) == built.map(|b| b.id.as_str()) {
                built
                    .and_then(|b| b.built_in.as_ref())
                    .map(|b| b.plan_detail.clone())
                    .unwrap_or_default()
            } else {
                match recommendation["workerModel"]
                    .as_str()
                    .filter(|m| first_same && !m.is_empty())
                {
                    Some(model) => crate::composer::controls::model_label(model),
                    None => "Uses each tool’s configured model".into(),
                }
            };
        let names = self
            .workers
            .iter()
            .map(|id| {
                inventory
                    .iter()
                    .find(|item| &item.id == id)
                    .map(|item| item.label.clone())
                    .unwrap_or_else(|| id.clone())
            })
            .collect::<Vec<_>>()
            .join(", ");
        let picker_enabled = !loading && !saving && !locked && !options.is_empty();
        let small = |text: String| {
            div()
                .mt(px(4.))
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child(text)
        };
        div()
            .debug_selector(|| "setup-customization".into())
            .flex()
            .flex_col()
            .gap(px(16.))
            .p(px(16.))
            .rounded(px(12.))
            .border_1()
            .border_color(theme().border)
            .bg(theme().background)
            .font_weight(FontWeight::LIGHT)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .child("Lead")
                            .child(small(lead_note)),
                    )
                    .child(
                        look::button("setup-lead-picker", "", picker_enabled, Look::Bordered)
                            .min_w(px(180.))
                            .justify_between()
                            .child(lead_label(&self.backend, inventory))
                            .child(crate::icon::stroke(
                                CHEVRON,
                                theme().text_secondary,
                                14.,
                                1.6,
                            ))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if picker_enabled {
                                    this.lead_menu = !this.lead_menu;
                                    this.revision += 1;
                                    cx.notify();
                                }
                            })),
                    ),
            )
            .when(self.lead_menu, |v| {
                v.child(
                    div()
                        .debug_selector(|| "setup-lead-menu".into())
                        .flex()
                        .flex_col()
                        .p(px(4.))
                        .rounded(px(10.))
                        .border_1()
                        .border_color(theme().border)
                        .bg(theme().surface_raised)
                        .children(options.iter().map(|backend| {
                            let chosen = *backend == self.backend;
                            let value = backend.clone();
                            look::button(
                                &format!("setup-lead-option-{backend}"),
                                "",
                                true,
                                Look::Quiet,
                            )
                            .min_h(px(36.))
                            .justify_between()
                            .text_color(theme().text)
                            .hover(|v| v.bg(theme().hover))
                            .child(lead_label(backend, inventory))
                            .when(chosen, |v| {
                                v.child(crate::icon::stroke(CHECK, theme().text, 14., 2.2))
                            })
                            .on_click(cx.listener(
                                move |this, _, _, cx| this.change_lead(value.clone(), cx),
                            ))
                        })),
                )
            })
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(relative(1.6))
                    .text_color(theme().text_secondary)
                    .child(
                        "Your lead plans the work, assigns tasks, and checks the result. Workers \
                         handle the tasks it delegates. You can change either later.",
                    ),
            )
            .when(locked, |v| {
                v.child(small(
                    "Your environment or subscription profile controls the lead. Change that in \
                     Settings to use another tool."
                        .into(),
                ))
            })
            .child(
                div()
                    .text_size(px(13.))
                    .child(format!(
                        "Workers: {}",
                        if names.is_empty() {
                            "Connect a tool".into()
                        } else {
                            names
                        }
                    ))
                    .child(small(worker_note)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(px(11.))
                            .line_height(relative(1.5))
                            .text_color(theme().text_muted)
                            .child(
                                "Choose the tools allowed to receive work. The first selected \
                                 tool is the default worker. OpenCode starts with its detected \
                                 configuration or a supported preset; choose a model in Settings \
                                 or name it in your task.",
                            ),
                    )
                    .children(visible(inventory, &self.workers).into_iter().map(|item| {
                        let chosen = self.workers.contains(&item.id);
                        let is_default = self.workers.first() == Some(&item.id);
                        let id = item.id.clone();
                        let enabled = !saving && !workers_locked && !loading;
                        worker_row(item, chosen, is_default, enabled).on_click(cx.listener(
                            move |this, _, _, cx| {
                                if !enabled {
                                    return;
                                }
                                this.choice_made = true;
                                let inventory = this
                                    .snapshot
                                    .as_ref()
                                    .map(Snapshot::inventory)
                                    .unwrap_or_default();
                                if this.workers.contains(&id) {
                                    if this.workers.len() > 1 {
                                        this.workers.retain(|w| w != &id);
                                    }
                                } else if available(&inventory, &id) {
                                    this.workers.push(id.clone());
                                }
                                this.revision += 1;
                                cx.notify();
                            },
                        ))
                    })),
            )
    }

    /// OnboardingToolsPanel: each tool's readiness, with install commands and
    /// setup instructions for the ones that are not ready.
    fn tools_panel(
        &self,
        inventory: &[Runtime],
        needs_connection: bool,
        loading: bool,
        saving: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let shown: Vec<&Runtime> = inventory
            .iter()
            .filter(|item| {
                item.built_in.is_none()
                    && (!needs_connection || item.id == "codex" || item.id == "claude-code")
            })
            .collect();
        let status = if loading {
            scan_status(self.scan_slow).to_owned()
        } else if let Some(id) = &self.copied {
            format!(
                "{} install command copied.",
                inventory
                    .iter()
                    .find(|item| &item.id == id)
                    .map(|item| item.label.as_str())
                    .unwrap_or("Tool")
            )
        } else {
            "Finish the tool’s setup, then refresh to check it. Your project, agent, and workers \
             stay selected."
                .into()
        };
        div()
            .debug_selector(|| "setup-tool-setup".into())
            .w_full()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                div()
                    .w_full()
                    .rounded(px(12.))
                    .border_1()
                    .border_color(theme().border)
                    .bg(theme().background)
                    .font_weight(FontWeight::LIGHT)
                    .children(shown.iter().enumerate().map(|(index, item)| {
                        let info = install(&item.id);
                        let command = info.and_then(|info| info.command.clone()).filter(|_| {
                            item.unavailable_reason.as_deref() == Some("not_installed")
                        });
                        let link = info.and_then(|info| info.link.clone());
                        let explain = if !item.fix.is_empty() {
                            item.fix.clone()
                        } else {
                            info.map(|info| info.hint.clone())
                                .unwrap_or_else(|| item.detail.clone())
                        };
                        let id = item.id.clone();
                        let label = item.label.clone();
                        div()
                            .debug_selector({
                                let id = format!("setup-tool-{}", item.id);
                                move || id.clone()
                            })
                            .p(px(16.))
                            .when(index > 0, |v| v.border_t_1().border_color(theme().border))
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .items_center()
                                    .gap(px(12.))
                                    .child(identity(&item.id, false))
                                    .child(
                                        div()
                                            .flex_1()
                                            .text_size(px(13.5))
                                            .child(item.label.clone()),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(if item.available {
                                                theme().success
                                            } else {
                                                theme().text_muted
                                            })
                                            .child(readiness(item)),
                                    ),
                            )
                            .when(!item.available, |v| {
                                v.child(
                                    div()
                                        .mt(px(12.))
                                        .flex()
                                        .flex_col()
                                        .gap(px(8.))
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .line_height(relative(1.5))
                                                .text_color(theme().text_secondary)
                                                .child(explain),
                                        )
                                        .when_some(command, |v, command| {
                                            let copied =
                                                self.copied.as_deref() == Some(id.as_str());
                                            let id = id.clone();
                                            let text = command.clone();
                                            v.child(
                                                div()
                                                    .flex()
                                                    .flex_wrap()
                                                    .items_center()
                                                    .gap(px(8.))
                                                    .child(
                                                        div()
                                                            .flex_1()
                                                            .min_w_0()
                                                            .p(px(12.))
                                                            .rounded(px(8.))
                                                            .bg(theme().surface_raised)
                                                            .font_family(theme().font_mono)
                                                            .text_size(px(12.))
                                                            .child(command),
                                                    )
                                                    .child(
                                                        look::button(
                                                            &format!("setup-copy-{id}"),
                                                            if copied {
                                                                "Copied"
                                                            } else {
                                                                "Copy command"
                                                            },
                                                            !saving,
                                                            Look::Bordered,
                                                        )
                                                        .on_click(cx.listener(
                                                            move |this, _, _, cx| {
                                                                cx.write_to_clipboard(
                                                                    gpui::ClipboardItem::new_string(
                                                                        text.clone(),
                                                                    ),
                                                                );
                                                                this.copied = Some(id.clone());
                                                                this.revision += 1;
                                                                cx.notify();
                                                            },
                                                        )),
                                                    ),
                                            )
                                        })
                                        .when_some(link, |v, link| {
                                            v.child(
                                                div().flex().child(
                                                    look::button(
                                                        &format!("setup-instructions-{id}"),
                                                        "",
                                                        true,
                                                        Look::Bordered,
                                                    )
                                                    .gap(px(8.))
                                                    .child(format!(
                                                        "Open {label} setup instructions"
                                                    ))
                                                    .child(crate::icon::stroke(
                                                        EXTERNAL,
                                                        theme().text,
                                                        14.,
                                                        1.6,
                                                    ))
                                                    .on_click(move |_, _, cx| cx.open_url(&link)),
                                                ),
                                            )
                                        }),
                                )
                            })
                    }))
                    .when(shown.is_empty(), |v| {
                        v.child(
                            div()
                                .p(px(16.))
                                .text_size(px(12.))
                                .text_color(theme().text_secondary)
                                .child("No tool inventory was returned. Refresh to try again."),
                        )
                    }),
            )
            .child(
                div()
                    .debug_selector(|| "setup-tools-status".into())
                    .text_size(px(12.))
                    .line_height(relative(1.5))
                    .text_color(theme().text_secondary)
                    .child(status),
            )
    }
}

#[cfg(test)]
#[test]
fn install_table_parses_with_the_desktop_commands() {
    // The table falls back to empty at runtime; a broken copy must fail here.
    let table: HashMap<String, Install> =
        serde_json::from_str(include_str!("runtime-install.json")).expect("runtime-install.json");
    assert!(table.len() >= 10);
    let codex = install("codex").expect("codex install info");
    assert_eq!(codex.command.as_deref(), Some("npm i -g @openai/codex"));
    assert!(install("antigravity").and_then(|info| info.link.as_deref()).is_some());
}
