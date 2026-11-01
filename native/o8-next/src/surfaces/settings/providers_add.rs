//! Settings › Providers › "+": the Add provider dialog, shaped like T3's.
//!
//! Built-in runtimes o8 knows sit in a grid at the top; below them is the ACP
//! registry with search. A built-in tile creates a new provider instance of
//! that runtime (`POST /api/runtime/provider-instances`). Adding a registry
//! agent prepares its pinned npm package (`/api/runtime/acp-registry/prepare`,
//! setup scripts off) and saves it as a new ACP instance; "Configure manually"
//! does the same from a name, executable and arguments. Classic's Local ACP
//! slot is never replaced. Nothing here starts an agent.
use super::{call, icon, instance::INSTANCES};
use crate::{client::Client, composer::Composer, theme::current as theme};
use gpui::{
    div, prelude::*, px, AnyElement, Context, Div, Entity, EventEmitter, FocusHandle, IntoElement,
    KeyDownEvent, ParentElement, Render, Stateful, Styled, Subscription, Window,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, rc::Rc, time::Duration};

const REGISTRY: &str = "/api/runtime/acp-registry";
const PREPARE: &str = "/api/runtime/acp-registry/prepare";
const CONNECTION: &str = "/api/runtime/acp-connection";
/// Preparing downloads a pinned package; registry reads have a 10s server cap.
const PREPARE_TIMEOUT: Duration = Duration::from_secs(120);
const READ_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Agent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub npm: Option<Value>,
    pub fingerprint: String,
}
#[derive(Deserialize)]
struct Catalog {
    agents: Vec<Agent>,
    #[serde(default)]
    stale: bool,
}
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct Connection {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}
#[derive(Deserialize)]
struct ConnectionState {
    connection: Option<Connection>,
    #[serde(rename = "envLocked", default)]
    locked: bool,
}
#[derive(Deserialize)]
struct Prepared {
    connection: Connection,
}

/// Case-insensitive name/description search, as classic's picker.
pub(crate) fn matches(agent: &Agent, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    query.is_empty()
        || format!("{} {}", agent.name, agent.description)
            .to_lowercase()
            .contains(&query)
}
/// The save body classic's LocalAcpSection posts. One literal arg per line.
pub(crate) fn connection_body(name: &str, command: &str, args: &str) -> Value {
    let args: Vec<&str> = args.lines().filter(|l| !l.trim().is_empty()).collect();
    json!({"connection": {"name": name.trim(), "command": command.trim(), "args": args, "useOpenRouter": false}})
}
/// The `create` body for a new ACP instance.
pub(crate) fn acp_instance_body(name: &str, command: &str, args: &str) -> Value {
    let connection = connection_body(name, command, args)["connection"].clone();
    json!({"action": "create", "instance": {"runtime": "acp", "name": connection["name"], "acp": connection}})
}
#[derive(Deserialize)]
struct Created {
    instance: CreatedInstance,
}
#[derive(Deserialize)]
struct CreatedInstance {
    id: String,
    name: String,
}

pub(crate) enum AddEvent {
    Close,
    Saved,
    /// A new instance was saved; the list selects it.
    Created(String),
}
impl EventEmitter<AddEvent> for AddProvider {}

pub(crate) struct Manual {
    name: Entity<Composer>,
    command: Entity<Composer>,
    args: Entity<Composer>,
}

pub(crate) struct AddProvider {
    client: Client,
    builtins: Vec<(String, String)>,
    pub catalog: Option<Vec<Agent>>,
    stale: bool,
    pub loading: bool,
    pub current: Option<Connection>,
    pub locked: bool,
    pub busy: Option<String>,
    pub notice: String,
    pub error: Option<String>,
    pub(crate) search: Entity<Composer>,
    pub manual: Option<Manual>,
    controls: BTreeMap<String, FocusHandle>,
    generation: u64,
    pub revision_count: u64,
    subscriptions: Vec<Subscription>,
}

fn field(
    placeholder: &str,
    text: &str,
    multiline: bool,
    window: &mut Window,
    cx: &mut gpui::App,
) -> Entity<Composer> {
    let input = cx.new(|cx| {
        let mut input = Composer::new(cx);
        input.inline = !multiline;
        input.newline_on_enter = multiline;
        input.placeholder = placeholder.into();
        input
    });
    if !text.is_empty() {
        input.update(cx, |i, cx| {
            gpui::EntityInputHandler::replace_text_in_range(i, None, text, window, cx)
        });
    }
    input
}

impl AddProvider {
    pub fn new(client: Client, builtins: Vec<(String, String)>, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.inline = true;
            input.placeholder = "Search agents…".into();
            input
        });
        let subscription = cx.observe(&search, |this, _, cx| this.changed(cx));
        let mut view = Self {
            client,
            builtins,
            catalog: None,
            stale: false,
            loading: false,
            current: None,
            locked: false,
            busy: None,
            notice: String::new(),
            error: None,
            search,
            manual: None,
            controls: BTreeMap::new(),
            generation: 0,
            revision_count: 0,
            subscriptions: vec![subscription],
        };
        view.load(cx);
        view
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision_count += 1;
        cx.notify();
    }
    /// Registry and current connection together; either may fail alone.
    pub fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let state =
                call::<ConnectionState>(&client, "GET", CONNECTION, Value::Null, READ_TIMEOUT);
            let catalog = call::<Catalog>(&client, "GET", REGISTRY, Value::Null, READ_TIMEOUT);
            (state, catalog)
        });
        cx.spawn(async move |this, cx| {
            let (state, catalog) = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match state {
                    Ok(state) => {
                        this.current = state.connection;
                        this.locked = state.locked;
                    }
                    Err(error) => this.error = Some(error),
                }
                match catalog {
                    Ok(catalog) => {
                        this.stale = catalog.stale;
                        this.catalog = Some(catalog.agents);
                        if catalog.stale {
                            this.notice =
                                "Showing a saved catalog. Refresh before adding an agent.".into();
                        }
                    }
                    Err(_) => {
                        this.catalog = Some(vec![]);
                        this.error = Some(
                            "Agents could not be loaded. Retry or configure one manually.".into(),
                        );
                    }
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    /// Prepare the pinned package, then save it as the Local ACP connection.
    pub fn add(&mut self, agent: Agent, cx: &mut Context<Self>) {
        if self.busy.is_some() || self.locked || self.stale || agent.npm.is_none() {
            return;
        }
        self.busy = Some(agent.id.clone());
        self.error = None;
        self.notice = format!("Preparing {}…", agent.name);
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let prepared: Prepared = call(
                &client,
                "POST",
                PREPARE,
                json!({"id": agent.id, "fingerprint": agent.fingerprint}),
                PREPARE_TIMEOUT,
            )?;
            let c = prepared.connection;
            create(&client, acp_instance_body(&c.name, &c.command, &c.args.join("\n")))
        });
        self.finish(task, cx);
        self.changed(cx);
    }
    fn finish(
        &mut self,
        task: gpui::Task<Result<CreatedInstance, String>>,
        cx: &mut Context<Self>,
    ) {
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                match result {
                    Ok(created) => {
                        this.manual = None;
                        this.notice = format!("Added “{}” as a new ACP instance.", created.name);
                        cx.emit(AddEvent::Saved);
                        cx.emit(AddEvent::Created(created.id));
                    }
                    Err(error) => {
                        this.notice.clear();
                        this.error = Some(error);
                    }
                }
                this.changed(cx);
            });
        })
        .detach();
    }
    /// A built-in tile: a new instance of that runtime, named "new" until
    /// renamed in its detail panel.
    pub fn add_builtin(&mut self, runtime: String, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        self.busy = Some(runtime.clone());
        self.error = None;
        self.notice = "Adding an instance…".into();
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            create(
                &client,
                json!({"action": "create", "instance": {"runtime": runtime, "name": "new"}}),
            )
        });
        self.finish(task, cx);
        self.changed(cx);
    }
    pub fn open_manual(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.manual.is_some() {
            self.manual = None;
            return self.changed(cx);
        }
        // Always a new instance; classic's Local ACP slot is left alone.
        let current = Connection {
            name: "ACP agent".into(),
            args: vec!["acp".into()],
            ..Default::default()
        };
        let manual = Manual {
            name: field("Name", &current.name, false, window, cx),
            command: field(
                "agent executable or full path",
                &current.command,
                false,
                window,
                cx,
            ),
            args: field("acp", &current.args.join("\n"), true, window, cx),
        };
        manual.command.read(cx).focus.focus(window);
        self.subscriptions.truncate(1);
        for input in [&manual.name, &manual.command, &manual.args] {
            self.subscriptions
                .push(cx.observe(input, |this, _, cx| this.changed(cx)));
        }
        self.manual = Some(manual);
        self.changed(cx);
    }
    pub fn save_manual(&mut self, cx: &mut Context<Self>) {
        let Some(manual) = &self.manual else { return };
        if self.busy.is_some() || self.locked {
            return;
        }
        let name = manual.name.read(cx).text.clone();
        let command = manual.command.read(cx).text.clone();
        let args = manual.args.read(cx).text.clone();
        if name.trim().is_empty() || command.trim().is_empty() {
            self.error = Some("Enter a name and an executable.".into());
            return self.changed(cx);
        }
        self.busy = Some("manual".into());
        self.error = None;
        self.notice = "Saving connection…".into();
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            create(&client, acp_instance_body(&name, &command, &args))
        });
        self.finish(task, cx);
        self.changed(cx);
    }

    fn focus(&mut self, id: &str, cx: &mut Context<Self>) -> FocusHandle {
        self.controls
            .entry(id.to_owned())
            .or_insert_with(|| cx.focus_handle())
            .clone()
    }
    fn control(
        &mut self,
        id: String,
        enabled: bool,
        window: &Window,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
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
            .when(!enabled, |v| v.opacity(0.45))
            .on_click(cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                if enabled {
                    action(this, window, cx);
                }
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if enabled && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    key_action(this, window, cx);
                    cx.stop_propagation();
                }
            }))
    }
    fn button(
        &mut self,
        id: String,
        label: String,
        primary: bool,
        enabled: bool,
        window: &Window,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> AnyElement {
        self.control(id, enabled, window, cx, action)
            .h(px(26.))
            .px(px(10.))
            .flex()
            .flex_shrink_0()
            .items_center()
            .rounded(px(7.))
            .text_size(px(12.))
            .bg(if primary {
                theme().accent
            } else {
                theme().surface_raised
            })
            .when(primary, |v| v.text_color(gpui::white()))
            .hover(|v| v.bg(theme().hover))
            .child(label)
            .into_any_element()
    }
    fn input_box(input: &Entity<Composer>, focus: FocusHandle, height: f32) -> Div {
        div()
            .w_full()
            .min_h(px(height))
            .px(px(10.))
            .py(px(6.))
            .rounded(px(7.))
            .border_1()
            .border_color(theme().border)
            .bg(theme().surface_raised)
            .text_size(px(12.))
            .on_mouse_down(gpui::MouseButton::Left, move |_, window, _| {
                focus.focus(window)
            })
            .child(input.clone())
    }
    fn agent_row(&mut self, agent: Agent, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.busy.as_deref() == Some(agent.id.as_str());
        let can = agent.npm.is_some() && self.busy.is_none() && !self.locked && !self.stale;
        let label = if busy {
            "Adding…"
        } else {
            "Add"
        };
        let action = if agent.npm.is_some() {
            let pick = agent.clone();
            self.button(
                format!("provider-acp-add-{}", agent.id),
                label.into(),
                false,
                can,
                window,
                cx,
                move |this, _, cx| this.add(pick.clone(), cx),
            )
        } else {
            div()
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child("Setup guide only")
                .into_any_element()
        };
        let link = agent.website.clone().unwrap_or_default();
        let id = agent.id.clone();
        div()
            .debug_selector(move || format!("provider-acp-{id}"))
            .flex()
            .items_center()
            .gap(px(12.))
            .px(px(10.))
            .py(px(8.))
            .border_b_1()
            .border_color(theme().border)
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
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(12.5))
                                    .child(agent.name.clone()),
                            )
                            .child(
                                div()
                                    .text_size(px(10.5))
                                    .text_color(theme().text_muted)
                                    .child(agent.version.clone()),
                            ),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(agent.description.clone()),
                    )
                    .when(!link.is_empty(), |v| {
                        v.child(
                            div()
                                .truncate()
                                .text_size(px(10.5))
                                .text_color(theme().text_secondary)
                                .child(link),
                        )
                    }),
            )
            .child(action)
            .into_any_element()
    }
    fn manual_form(&mut self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let manual = self.manual.as_ref()?;
        let (name, command, args) = (
            manual.name.clone(),
            manual.command.clone(),
            manual.args.clone(),
        );
        let ready =
            !name.read(cx).text.trim().is_empty() && !command.read(cx).text.trim().is_empty();
        let enabled = ready && self.busy.is_none() && !self.locked;
        let save_label = "Add instance";
        let save = self.button(
            "provider-acp-save".into(),
            save_label.into(),
            true,
            enabled,
            window,
            cx,
            |this, _, cx| this.save_manual(cx),
        );
        let cancel = self.button(
            "provider-acp-cancel".into(),
            "Cancel".into(),
            false,
            true,
            window,
            cx,
            |this, window, cx| this.open_manual(window, cx),
        );
        let label = |text: &'static str| {
            div()
                .text_size(px(11.5))
                .text_color(theme().text_secondary)
                .child(text)
        };
        Some(
            div()
                .debug_selector(|| "provider-acp-form".into())
                .flex()
                .flex_col()
                .gap(px(6.))
                .p(px(12.))
                .rounded(px(8.))
                .border_1()
                .border_color(theme().border)
                .child(div().text_size(px(13.)).child("Configure manually"))
                .child(label("Name"))
                .child(Self::input_box(&name, name.read(cx).focus.clone(), 28.).debug_selector(|| "provider-acp-name".into()))
                .child(label("Executable"))
                .child(Self::input_box(&command, command.read(cx).focus.clone(), 28.).debug_selector(|| "provider-acp-command".into()))
                .child(label("Arguments, one per line"))
                .child(Self::input_box(&args, args.read(cx).focus.clone(), 64.).debug_selector(|| "provider-acp-args".into()))
                .child(div().text_size(px(11.)).text_color(theme().text_muted).child(
                    "Use one literal argument per line. Keep secrets out of arguments; add them as secret variables in the instance panel.",
                ))
                .child(div().flex().gap(px(8.)).child(save).child(cancel))
                .into_any_element(),
        )
    }
}

impl Render for AddProvider {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let close = self
            .control("provider-add-close".into(), true, window, cx, |_, _, cx| {
                cx.emit(AddEvent::Close)
            })
            .size(px(22.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .hover(|v| v.bg(theme().hover))
            .child(crate::icon::stroke(
                "M6 6l12 12M18 6 6 18",
                theme().text_secondary,
                12.,
                2.,
            ));
        let mut grid = div().flex().flex_wrap().gap(px(8.));
        for (id, label) in self.builtins.clone() {
            let pick = id.clone();
            grid = grid.child(
                self.control(
                    format!("provider-add-builtin-{id}"),
                    true,
                    window,
                    cx,
                    move |this, _, cx| this.add_builtin(pick.clone(), cx),
                )
                .w(px(196.))
                .h(px(36.))
                .px(px(12.))
                .flex()
                .items_center()
                .gap(px(10.))
                .rounded(px(8.))
                .border_1()
                .border_color(theme().border)
                .bg(theme().surface_raised)
                .hover(|v| v.bg(theme().hover))
                .child(icon(&id, theme().text))
                .child(div().truncate().text_size(px(12.5)).child(label)),
            );
        }
        let manual_label = if self.manual.is_some() {
            "Hide manual setup"
        } else {
            "Configure manually"
        };
        let manual = self.button(
            "provider-acp-manual".into(),
            manual_label.into(),
            false,
            !self.locked,
            window,
            cx,
            |this, window, cx| this.open_manual(window, cx),
        );
        let query = self.search.read(cx).text.clone();
        let agents: Vec<Agent> = self
            .catalog
            .clone()
            .unwrap_or_default()
            .into_iter()
            .filter(|a| matches(a, &query))
            .collect();
        let mut list = div()
            .debug_selector(|| "provider-acp-list".into())
            .flex()
            .flex_col();
        let empty = agents.is_empty();
        for agent in agents {
            list = list.child(self.agent_row(agent, window, cx));
        }
        if self.catalog.is_some() && empty && !self.loading {
            list = list.child(
                div()
                    .py(px(8.))
                    .text_size(px(11.5))
                    .text_color(theme().text_muted)
                    .child("No matching agents."),
            );
        }
        if self.loading {
            list = list.child(
                div()
                    .py(px(8.))
                    .text_size(px(11.5))
                    .text_color(theme().text_muted)
                    .child("Loading the ACP registry…"),
            );
        }
        let form = self.manual_form(window, cx);
        let search_focus = self.search.read(cx).focus.clone();
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
            .bg(theme().surface)
            .child(
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(div().text_size(px(15.)).child("Add provider"))
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .text_color(theme().text_muted)
                                    .child("Pick a runtime o8 knows, or connect an ACP agent."),
                            ),
                    )
                    .child(close),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(theme().text_secondary)
                    .child("Provider"),
            )
            .child(grid)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(div().flex_1().h(px(1.)).bg(theme().border))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child("Or choose from ACP Registry"),
                    )
                    .child(div().flex_1().h(px(1.)).bg(theme().border)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("provider-acp-search")
                            .debug_selector(|| "provider-acp-search".into())
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .px(px(10.))
                            .py(px(6.))
                            .rounded(px(7.))
                            .border_1()
                            .border_color(theme().border)
                            .bg(theme().surface_raised)
                            .text_size(px(12.))
                            .on_mouse_down(gpui::MouseButton::Left, move |_, window, _| {
                                search_focus.focus(window)
                            })
                            .child(self.search.clone()),
                    )
                    .child(manual),
            )
            .when(self.locked, |v| {
                v.child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child("Controlled by O8_ACP_COMMAND in your environment."),
                )
            })
            .children(form)
            .child(
                div()
                    .id("provider-acp-scroll")
                    .max_h(px(360.))
                    .overflow_y_scroll()
                    .child(list),
            )
            .when(!self.notice.is_empty(), |v| {
                v.child(
                    div()
                        .debug_selector(|| "provider-acp-notice".into())
                        .text_size(px(11.5))
                        .text_color(theme().text_secondary)
                        .child(self.notice.clone()),
                )
            })
            .when_some(self.error.clone(), |v, e| {
                v.child(
                    div()
                        .debug_selector(|| "provider-acp-error".into())
                        .text_size(px(11.5))
                        .text_color(theme().danger)
                        .child(e),
                )
            })
    }
}

fn create(client: &Client, body: Value) -> Result<CreatedInstance, String> {
    client
        .settings_request::<Created>("POST", INSTANCES, body)
        .map(|c| c.instance)
        .map_err(|e| e.message)
}
