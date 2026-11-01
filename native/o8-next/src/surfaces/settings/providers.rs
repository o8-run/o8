//! Settings › Providers: one row per runtime o8 knows, T3-style.
//!
//! Reads only existing server data: `dispatchableRuntimes` from operator
//! defaults (the runtime registry plus its auth readiness), `/api/setup/detect`
//! for the CLI version and binary path, and the native settings snapshot for
//! `disabledRuntimes` and the settings.toml revision. The switch writes
//! `disabledRuntimes` through the same native settings POST as every other
//! Settings switch. Nothing credential-shaped is deserialized or retained.
use crate::{client::Client, settings::RequestError, theme::current as theme};
use gpui::{
    AnyElement, Context, Div, FocusHandle, IntoElement, KeyDownEvent, ParentElement, Render,
    Stateful, Styled, Window, div, prelude::*, px,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{cell::Cell, collections::BTreeMap, rc::Rc};

const INVENTORY: &str = "/api/panel/operator-defaults";
const NATIVE: &str = "/api/panel/operator-defaults?include=native";
const DETECT: &str = "/api/setup/detect";

#[derive(Clone, Debug, Default, Deserialize)]
struct RuntimeConnection {
    #[serde(default)]
    providers: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Runtime {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    unavailable_reason: Option<String>,
    #[serde(default)]
    connection: Option<RuntimeConnection>,
}
#[derive(Deserialize)]
struct Inventory {
    #[serde(rename = "dispatchableRuntimes")]
    runtimes: Vec<Runtime>,
}
#[derive(Default, Deserialize)]
struct NativeValues {
    #[serde(rename = "disabledRuntimes", default)]
    disabled: Vec<String>,
}
#[derive(Deserialize)]
struct NativeToml {
    revision: String,
}
#[derive(Deserialize)]
struct Native {
    #[serde(default)]
    values: NativeValues,
    #[serde(rename = "settingsToml")]
    toml: Option<NativeToml>,
}
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Tool {
    id: String,
    #[serde(default)]
    detected: bool,
    version: Option<String>,
    path: Option<String>,
}
#[derive(Deserialize)]
struct Detect {
    tools: Vec<Tool>,
}

pub(crate) struct Loaded {
    runtimes: Vec<Runtime>,
    disabled: Vec<String>,
    revision: Option<String>,
    tools: Option<BTreeMap<String, Tool>>,
}

/// "codex-cli 0.162.1" → "v0.162.1"; anything without a number is dropped.
pub(crate) fn version(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .map(|t| t.trim_start_matches('v').trim_end_matches(','))
        .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()) && t.contains('.'))
        .map(|t| format!("v{t}"))
}

/// T3's status line: "Authenticated · <source>", "Available", "Disabled".
pub(crate) fn status(runtime: &Runtime, disabled: bool) -> String {
    if disabled {
        return "Disabled".into();
    }
    if runtime.available {
        let providers = runtime
            .connection
            .as_ref()
            .map(|c| c.providers.join(", "))
            .unwrap_or_default();
        return if providers.is_empty() {
            "Available".into()
        } else {
            format!("Authenticated · {providers}")
        };
    }
    match runtime.unavailable_reason.as_deref() {
        _ if !runtime.installed => "Not installed".into(),
        Some("needs_auth") => "Installed · sign-in needed".into(),
        Some("needs_restart") => "Installed · restart needed".into(),
        _ => "Installed · check setup".into(),
    }
}

/// The home directory a runtime reads, as its selector and default. Mirrors
/// classic's runtime-profile-paths.ts; read-only and never resolved here, so
/// no real home path reaches the UI.
pub(crate) fn home(id: &str) -> &'static str {
    match id {
        "codex" => "CODEX_HOME (default ~/.codex)",
        "claude-code" => "CLAUDE_CONFIG_DIR (default ~/.claude)",
        "gemini" => "GEMINI_CLI_HOME (default ~/.gemini)",
        "hermes" => "HERMES_HOME (default ~/.hermes)",
        "opencode" => "OPENCODE_CONFIG_DIR (default ~/.config/opencode)",
        "pi" | "pi-builtin" => "PI_CODING_AGENT_DIR (default ~/.pi)",
        "cursor" => "CURSOR_CONFIG_DIR (default ~/.cursor)",
        "grok" => "HOME (default ~/.grok)",
        _ => "HOME",
    }
}

const ANTHROPIC: &str = "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";
const OPENAI: &str = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const OPENCODE: &str = "M16.8 4.8H7.2v14.4h9.6V4.8ZM21.6 24H2.4V0h19.2v24Z";
fn icon(id: &str, color: gpui::Rgba) -> gpui::Svg {
    match id {
        "claude-code" => crate::icon::fill(ANTHROPIC, color, 16.),
        "codex" => crate::icon::fill(OPENAI, color, 16.),
        "opencode" => crate::icon::fill(OPENCODE, color, 16.),
        "pi" | "pi-builtin" => {
            crate::icon::stroke("M4 8h16M8 8v12M16 8v9q0 3 3 3", color, 16., 2.5)
        }
        "grok" => crate::icon::stroke("M5 4l14 16M19 4 5 20", color, 16., 2.2),
        "cursor" => crate::icon::stroke(
            "M12 2 21 7v10l-9 5-9-5V7l9-5Zm0 0v20M3 7l18 10",
            color,
            16.,
            1.6,
        ),
        "gemini" | "antigravity" => {
            crate::icon::stroke("M12 3q1 8 9 9-8 1-9 9-1-8-9-9 8-1 9-9Z", color, 16., 1.8)
        }
        _ => crate::icon::stroke("m5 7 5 5-5 5M12 19h7", color, 16., 2.2),
    }
}

pub(crate) struct Providers {
    client: Client,
    pub runtimes: Vec<Runtime>,
    pub disabled: Vec<String>,
    revision: Option<String>,
    pub tools: Option<BTreeMap<String, Tool>>,
    pub selected: Option<String>,
    pub add_open: bool,
    pub busy: bool,
    pub loaded: bool,
    pub error: Option<String>,
    note: String,
    controls: BTreeMap<String, FocusHandle>,
    generation: u64,
    pub revision_count: u64,
    pub painted: Rc<Cell<u64>>,
}

impl Providers {
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let mut view = Self {
            client,
            runtimes: Vec::new(),
            disabled: Vec::new(),
            revision: None,
            tools: None,
            selected: None,
            add_open: false,
            busy: false,
            loaded: false,
            error: None,
            note: String::new(),
            controls: BTreeMap::new(),
            generation: 0,
            revision_count: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
        };
        view.load(cx);
        view
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision_count += 1;
        cx.notify();
    }
    fn read(client: &Client) -> Result<Loaded, RequestError> {
        let inventory: Inventory = client.settings_request("GET", INVENTORY, Value::Null)?;
        let native: Native = client.settings_request("GET", NATIVE, Value::Null)?;
        // Detection runs CLIs with a deadline; a refusal only hides versions.
        let tools = client
            .settings_request::<Detect>("GET", DETECT, Value::Null)
            .ok()
            .map(|d| d.tools.into_iter().map(|t| (t.id.clone(), t)).collect());
        Ok(Loaded {
            runtimes: inventory.runtimes,
            disabled: native.values.disabled,
            revision: native.toml.map(|t| t.revision),
            tools,
        })
    }
    fn receive(
        &mut self,
        result: Result<Loaded, RequestError>,
        saved: bool,
        cx: &mut Context<Self>,
    ) {
        self.busy = false;
        match result {
            Ok(loaded) => {
                self.runtimes = loaded.runtimes;
                self.disabled = loaded.disabled;
                self.revision = loaded.revision;
                if loaded.tools.is_some() || self.tools.is_none() {
                    self.tools = loaded.tools;
                }
                self.loaded = true;
                self.error = None;
                self.note = if saved {
                    "Saved. New sessions use this.".into()
                } else {
                    String::new()
                };
            }
            Err(error) => {
                self.note.clear();
                self.error = Some(error.message);
            }
        }
        self.changed(cx);
    }
    pub fn load(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.note = "Checking providers…".into();
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { Self::read(&client) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation == generation {
                    this.receive(result, false, cx);
                }
            });
        })
        .detach();
        self.changed(cx);
    }
    /// Flip one runtime in `disabledRuntimes`. The switch only moves when the
    /// re-read server value says so, like the other Settings switches.
    pub fn toggle(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.busy || !self.loaded {
            return;
        }
        let mut disabled = self.disabled.clone();
        if let Some(index) = disabled.iter().position(|d| d == id) {
            disabled.remove(index);
        } else {
            disabled.push(id.to_owned());
        }
        self.busy = true;
        self.error = None;
        self.note = "Saving…".into();
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let body = json!({"disabledRuntimes": disabled, "settingsTomlRevision": self.revision});
        let task = cx.background_executor().spawn(async move {
            let _: serde::de::IgnoredAny = client.settings_request("POST", NATIVE, body)?;
            Self::read(&client).map_err(|_| RequestError {
                status: None,
                message: "The change was accepted, but providers are unavailable. Refresh before trying again.".into(),
            })
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation == generation {
                    this.receive(result, true, cx);
                }
            });
        })
        .detach();
        self.changed(cx);
    }
    pub fn select(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.selected = id;
        self.add_open = false;
        self.changed(cx);
    }
    pub fn open_add(&mut self, cx: &mut Context<Self>) {
        self.add_open = !self.add_open;
        if self.add_open {
            self.selected = None;
        }
        self.changed(cx);
    }
    fn focus(&mut self, id: &str, cx: &mut Context<Self>) -> FocusHandle {
        self.controls
            .entry(id.to_owned())
            .or_insert_with(|| cx.focus_handle())
            .clone()
    }
    /// A focusable control that runs `action` on click, Enter or Space.
    fn control(
        &mut self,
        id: String,
        enabled: bool,
        window: &Window,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> Stateful<Div> {
        let focus = self.focus(&id, cx);
        let focused = focus.is_focused(window);
        let action = Rc::new(action);
        let key_action = action.clone();
        div()
            .id(gpui::SharedString::from(id.clone()))
            .debug_selector(move || id.clone())
            .track_focus(&focus)
            .tab_stop(enabled)
            .when(focused, |v| v.border_1().border_color(theme().accent))
            .when(enabled, |v| v.cursor_pointer())
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                if enabled {
                    action(this, cx);
                }
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                if enabled && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    key_action(this, cx);
                    cx.stop_propagation();
                }
            }))
    }
    /// Q's Settings switch: a 34×20 track, knob at the end that matches the
    /// saved value. Its size never changes, so a save never shifts the row.
    fn switch(
        &mut self,
        id: &str,
        on: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let enabled = !self.busy && self.loaded;
        let runtime = id.to_owned();
        self.control(
            format!("provider-switch-{id}"),
            enabled,
            window,
            cx,
            move |this, cx| this.toggle(&runtime, cx),
        )
        .w(px(34.))
        .h(px(20.))
        .flex_shrink_0()
        .rounded_full()
        .opacity(if enabled { 1. } else { 0.45 })
        .child(
            div()
                .size_full()
                .p(px(2.))
                .flex()
                .items_center()
                .rounded_full()
                .bg(if on { theme().accent } else { theme().border })
                .when(on, |v| v.justify_end())
                .child(
                    div()
                        .size(px(16.))
                        .rounded_full()
                        .bg(gpui::white())
                        .shadow_sm(),
                ),
        )
        .into_any_element()
    }
    fn row(&mut self, runtime: Runtime, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let disabled = self.disabled.contains(&runtime.id);
        let selected = self.selected.as_deref() == Some(runtime.id.as_str());
        let tool = self
            .tools
            .as_ref()
            .and_then(|t| t.get(&runtime.id))
            .cloned();
        let version = tool
            .as_ref()
            .and_then(|t| t.version.as_deref())
            .and_then(version);
        let id = runtime.id.clone();
        let switch = self.switch(&runtime.id, !disabled, window, cx);
        let color = if disabled {
            theme().text_muted
        } else {
            theme().text
        };
        self.control(
            format!("provider-row-{id}"),
            true,
            window,
            cx,
            move |this, cx| {
                let next = (this.selected.as_deref() != Some(id.as_str())).then(|| id.clone());
                this.select(next, cx)
            },
        )
        .flex()
        .items_center()
        .gap(px(12.))
        .px(px(12.))
        .py(px(10.))
        .rounded(px(8.))
        .bg(if selected {
            theme().selection
        } else {
            theme().surface_raised
        })
        .hover(|v| v.bg(theme().hover))
        .child(icon(&runtime.id, color))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .flex()
                        .items_baseline()
                        .gap(px(8.))
                        .text_color(color)
                        .child(div().truncate().child(runtime.label.clone()))
                        .when_some(version, |v, version| {
                            v.child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(theme().text_muted)
                                    .child(version),
                            )
                        }),
                )
                .child(
                    div()
                        .debug_selector({
                            let id = runtime.id.clone();
                            move || format!("provider-status-{id}")
                        })
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(status(&runtime, disabled)),
                ),
        )
        .child(switch)
        .into_any_element()
    }
    fn detail(&self, runtime: &Runtime) -> AnyElement {
        let tool = self.tools.as_ref().and_then(|t| t.get(&runtime.id));
        let binary = match (self.tools.is_some(), tool) {
            (
                _,
                Some(Tool {
                    path: Some(path), ..
                }),
            ) => path.clone(),
            (
                true,
                Some(Tool {
                    detected: false, ..
                })
                | None,
            ) => "Not found on PATH".into(),
            (false, _) => "Detection unavailable".into(),
            _ => "Detected, path not reported".into(),
        };
        let line = |label: &'static str, help: &'static str, value: String| {
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .py(px(10.))
                .border_b_1()
                .border_color(theme().border)
                .child(div().text_size(px(12.5)).child(label))
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(help),
                )
                .child(
                    div()
                        .px(px(10.))
                        .py(px(6.))
                        .rounded(px(6.))
                        .bg(theme().surface_raised)
                        .text_size(px(12.))
                        .text_color(theme().text_secondary)
                        .font_family(theme().font_mono)
                        .child(value),
                )
        };
        div()
            .debug_selector(|| "provider-detail".into())
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .p(px(16.))
            .rounded(px(10.))
            .border_1()
            .border_color(theme().border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .pb(px(6.))
                    .child(icon(&runtime.id, theme().text))
                    .child(div().text_size(px(15.)).child(runtime.label.clone())),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(status(runtime, self.disabled.contains(&runtime.id))),
            )
            .child(line(
                "Display name",
                "Shown in lists and the composer.",
                runtime.label.clone(),
            ))
            .child(line("Runtime", "o8's runtime id.", runtime.id.clone()))
            .child(line(
                "Binary path",
                "The CLI o8 detected for this runtime.",
                binary,
            ))
            .child(line(
                "Home directory",
                "Config and auth directory, from the runtime's selector.",
                home(&runtime.id).into(),
            ))
            .child(
                div()
                    .pt(px(10.))
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child("Read-only for now. Editing paths arrives with provider instances."),
            )
            .into_any_element()
    }
    fn add_placeholder(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let close = self
            .control("provider-add-close".into(), true, window, cx, |this, cx| {
                this.open_add(cx)
            })
            .h(px(26.))
            .px(px(10.))
            .rounded(px(7.))
            .flex()
            .items_center()
            .text_size(px(12.))
            .bg(theme().surface_raised)
            .child("Close");
        div()
            .debug_selector(|| "provider-add".into())
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(10.))
            .p(px(16.))
            .rounded(px(10.))
            .border_1()
            .border_color(theme().border)
            .child(div().text_size(px(15.)).child("Add provider"))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(theme().text_muted)
                    .child("Adding accounts and ACP registry agents arrives in a later update. Built-in runtimes o8 detects are listed automatically."),
            )
            .child(div().flex().child(close))
            .into_any_element()
    }
}

impl Render for Providers {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let painted = self.painted.clone();
        let revision = self.revision_count;
        let add = self
            .control(
                "provider-add-button".into(),
                true,
                window,
                cx,
                |this, cx| this.open_add(cx),
            )
            .size(px(22.))
            .rounded(px(6.))
            .flex()
            .items_center()
            .justify_center()
            .bg(theme().surface_raised)
            .hover(|v| v.bg(theme().hover))
            .child(crate::icon::stroke(
                "M12 5v14M5 12h14",
                theme().text_secondary,
                12.,
                2.,
            ));
        let mut list = div()
            .w(px(380.))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .gap(px(6.));
        for runtime in self.runtimes.clone() {
            list = list.child(self.row(runtime, window, cx));
        }
        if self.loaded && self.runtimes.is_empty() {
            list = list.child(
                div()
                    .text_color(theme().text_muted)
                    .child("o8 does not report any runtimes."),
            );
        }
        let side = if self.add_open {
            Some(self.add_placeholder(window, cx))
        } else {
            self.selected
                .as_ref()
                .and_then(|id| self.runtimes.iter().find(|r| &r.id == id))
                .map(|r| self.detail(r))
        };
        div()
            .debug_selector(|| "settings-providers".into())
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child("Providers")
                    .child(add)
                    .when(!self.note.is_empty(), |v| {
                        v.child(div().text_size(px(11.)).text_color(theme().text_muted).child(self.note.clone()))
                    }),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child("Every runtime o8 knows. Turning one off hides it from new sessions; running sessions keep theirs."),
            )
            .when_some(self.error.clone(), |v, error| {
                v.child(div().debug_selector(|| "providers-error".into()).text_color(theme().danger).child(error))
            })
            .child(div().flex().items_start().gap(px(16.)).child(list).children(side))
            .when(self.loaded && !self.busy, |v| {
                v.child(div().debug_selector(|| "providers-loaded".into()).h(px(1.)))
            })
            .child(
                gpui::canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision))
                    .h(px(1.))
                    .w_full(),
            )
    }
}

#[cfg(test)]
#[path = "providers_tests.rs"]
mod tests;
