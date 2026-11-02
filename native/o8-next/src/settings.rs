//! Shared server settings, rendered in pure GPUI. Only view state lives here.
use crate::{
    client::Client,
    composer::{Composer, Submit},
    settings_fields::{Field, Kind, fields},
    settings_secret::Secret,
};
use gpui::{AppContext, Context, Entity, EntityInputHandler, EventEmitter, FocusHandle, Window};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{cell::Cell, collections::BTreeMap, rc::Rc};

const DEFAULTS: &str = "/api/panel/operator-defaults?include=native";
const KEYS: &str = "/api/v2/keys";
#[derive(Debug)]
pub(crate) struct RequestError {
    pub status: Option<u16>,
    pub message: String,
}
#[derive(Deserialize)]
pub(crate) struct Snapshot {
    pub values: BTreeMap<String, Value>,
    #[serde(default)]
    pub bots: Vec<BotSetupCandidate>,
    pub sources: BTreeMap<String, String>,
    #[serde(rename = "settingsToml")]
    pub toml: Option<Toml>,
}
#[derive(Clone, Deserialize)]
pub(crate) struct BotSetupCandidate {
    pub id: String,
    pub name: String,
    pub house: String,
    #[serde(rename = "selectionIds")]
    pub selection_ids: Vec<String>,
}
#[derive(Deserialize)]
pub(crate) struct Toml {
    text: String,
    revision: String,
    error: Option<String>,
    // Required: an older server returning raw TOML must fail closed.
    #[serde(rename = "additionalSettingsSet")]
    additional_settings_set: bool,
}
// Deliberately no maskedKey, key, token, label, environment, or credential fields.
#[derive(Debug, Deserialize)]
pub(crate) struct Inventory {
    pub providers: Vec<Provider>,
}
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Provider {
    pub id: String,
    pub configured: bool,
    pub enabled: bool,
    pub connection: Option<Connection>,
}
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Connection {
    state: ConnectionState,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ConnectionState {
    Disconnected,
    ConfiguredUnverified,
    Connected,
    Degraded,
    Disabled,
}
impl Provider {
    fn label(&self) -> &'static str {
        match self.id.as_str() {
            "openrouter" => "OpenRouter",
            "deepseek" => "DeepSeek",
            "anthropic" => "Anthropic",
            "openai" => "OpenAI",
            _ => "Unavailable provider",
        }
    }
    fn status(&self) -> &'static str {
        match self.connection.as_ref().map(|c| &c.state) {
            Some(ConnectionState::Disconnected) => "Not connected",
            Some(ConnectionState::ConfiguredUnverified) => "Configured, unverified",
            Some(ConnectionState::Connected) => "Connected",
            Some(ConnectionState::Degraded) => "Connection degraded",
            Some(ConnectionState::Disabled) => "Connection off",
            None => {
                if self.configured {
                    "Key present"
                } else {
                    "No key saved"
                }
            }
        }
    }
}
enum Data {
    Defaults(Snapshot),
    Keys(Inventory, bool),
}
#[derive(Clone)]
enum Target {
    Field(&'static Field, String),
    Key(String),
    File(String),
}
#[derive(Clone)]
enum Input {
    Text(Entity<Composer>),
    Secret(Entity<Secret>),
}
#[derive(Clone)]
struct Editor {
    target: Target,
    input: Input,
}
pub(crate) struct Close;
pub(crate) enum Action {
    Appearance(&'static str),
    Shortcuts,
}
impl EventEmitter<Action> for Settings {}
pub(crate) struct Settings {
    client: Client,
    pub snapshot: Option<Snapshot>,
    pub keys: Option<Inventory>,
    /// Settings › Providers, owned by the settings surface module.
    pub providers: Option<gpui::AnyView>,
    pub limits: Option<gpui::AnyView>,
    pub machines: Option<gpui::AnyView>,
    pub mcp: Option<gpui::AnyView>,
    section: &'static str,
    search: Entity<Composer>,
    editor: Option<Editor>,
    confirm: Option<String>,
    pub busy: bool,
    uncertain: bool,
    pub error: Option<String>,
    note: String,
    conflict: bool,
    open_file: bool,
    open_field: Option<&'static Field>,
    focus: FocusHandle,
    controls: BTreeMap<String, FocusHandle>,
    subscriptions: Vec<gpui::Subscription>,
    generation: u64,
    pub revision: u64,
    pub painted: Rc<Cell<u64>>,
    scroll: gpui::ScrollHandle,
    navigation: navigation::State,
    indexing: indexing::State,
    storage: storage::State,
    diagnostics: diagnostics::State,
    connections: connections::State,
    about_version: Option<String>,
    about_busy: bool,
    about_status: String,
    about_error: Option<String>,
}
impl EventEmitter<Close> for Settings {}
impl Settings {
    pub fn new(client: Client, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.focus = input.focus.clone().tab_stop(true);
            input.placeholder = "Search settings".into();
            input
        });
        let subscription = cx.observe(&search, |this, _, cx| this.changed(cx));
        let focus = cx.focus_handle();
        focus.focus(window);
        let mut view = Self {
            client,
            snapshot: None,
            keys: None,
            providers: None,
            limits: None,
            mcp: None,
            machines: None,
            section: "general",
            search,
            editor: None,
            confirm: None,
            busy: false,
            uncertain: false,
            error: None,
            note: String::new(),
            conflict: false,
            open_file: false,
            open_field: None,
            focus,
            controls: BTreeMap::new(),
            subscriptions: vec![subscription],
            generation: 0,
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            scroll: gpui::ScrollHandle::new(),
            navigation: navigation::State::default(),
            indexing: indexing::State::default(),
            storage: storage::State::default(),
            diagnostics: diagnostics::State::default(),
            connections: connections::State::default(),
            about_version: None,
            about_busy: false,
            about_status: String::new(),
            about_error: None,
        };
        view.load(false, cx);
        view
    }
    pub fn focus(&self, window: &mut Window) {
        self.focus.focus(window);
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        cx.notify();
    }
    fn receive(
        &mut self,
        result: Result<Data, RequestError>,
        mutation: bool,
        cx: &mut Context<Self>,
    ) {
        self.busy = false;
        match result {
            Ok(data) => {
                self.uncertain = false;
                self.error = None;
                match data {
                    Data::Defaults(mut snapshot) => {
                        // Never keep extra response fields as a native settings cache.
                        snapshot.values.retain(|id, _| fields().any(|f| f.id == id));
                        self.error = snapshot.toml.as_ref().and_then(|t| t.error.clone());
                        let rail_changed = self.snapshot.as_ref().is_some_and(|old| {
                            old.values.get("botRailEnabledIds")
                                != snapshot.values.get("botRailEnabledIds")
                        });
                        self.snapshot = Some(snapshot);
                        if rail_changed && !mutation {
                            crate::settings_fields::bot_rail_changed(&self.client);
                        }
                        if mutation {
                            self.note = "Saved. New actions use these settings.".into();
                        }
                    }
                    Data::Keys(keys, warning) => {
                        self.keys = Some(keys);
                        if mutation {
                            self.note = if warning { "Saved, but validation was unavailable. Recheck the connection." } else { "Updated. New sessions use this connection; running sessions keep theirs. External environment keys are unchanged." }.into();
                        }
                    }
                }
                if mutation {
                    self.editor = None;
                    self.confirm = None;
                    self.conflict = false;
                }
            }
            Err(error) => {
                self.note.clear();
                self.conflict = error.status == Some(409)
                    && self
                        .editor
                        .as_ref()
                        .is_some_and(|e| matches!(e.target, Target::File(_) | Target::Field(_, _)));
                if mutation {
                    self.uncertain = error.status.is_none();
                }
                self.error = Some(error.message);
                self.open_file = false;
                self.open_field = None;
            }
        }
        self.load_panel(false, cx);
        self.changed(cx);
    }
    fn read(client: &Client, keys: bool) -> Result<Data, RequestError> {
        if keys {
            let mut inventory: Inventory = client.settings_request("GET", KEYS, Value::Null)?;
            inventory.providers.retain(|p| {
                matches!(
                    p.id.as_str(),
                    "openrouter" | "deepseek" | "anthropic" | "openai"
                )
            });
            Ok(Data::Keys(inventory, false))
        } else {
            let data: Snapshot = client.settings_request("GET", DEFAULTS, Value::Null)?;
            if data.values.is_empty() {
                return Err(RequestError {
                    status: Some(502),
                    message: "Settings are unavailable. Refresh to try again.".into(),
                });
            }
            Ok(Data::Defaults(data))
        }
    }
    fn load(&mut self, open_file: bool, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.open_file = open_file;
        self.error = None;
        self.note = "Reading settings…".into();
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let keys = self.section == "keys" && !open_file;
        let task = cx
            .background_executor()
            .spawn(async move { Self::read(&client, keys) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.note.clear();
                this.receive(result, false, cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    fn select(&mut self, section: &'static str, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.editor = None;
        self.confirm = None;
        self.conflict = false;
        self.navigation.remember(section);
        self.section = section;
        self.search.update(cx, |s, cx| s.clear(cx));
        self.scroll
            .set_offset(gpui::point(gpui::px(0.), gpui::px(0.)));
        self.load(false, cx);
        if section == "indexing" {
            self.load_indexing_counts(true, cx);
        }
        self.load_panel(false, cx);
    }
    fn load_panel(&mut self, force: bool, cx: &mut Context<Self>) {
        if self.section == "about" {
            self.load_about(force, cx);
        }
        if self.section == "connections" {
            self.load_connections(force, cx);
        }
        if self.section == "diagnostics" {
            self.load_diagnostics(force, cx);
        }
        if self.section == "storage" {
            self.load_storage(force, cx);
        }
        if self.section == "indexing" {
            self.load_indexing(force, cx);
        }
    }
    fn locked(&self, field: &Field) -> bool {
        self.busy
            || self.uncertain
            || self.snapshot.as_ref().is_none_or(|s| {
                !s.values.contains_key(field.id)
                    || s.sources.get(field.id).is_some_and(|s| s == "env")
                    || field.dependency_reason(&s.values).is_some()
            })
    }
    fn begin(&mut self, target: Target, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.uncertain {
            return;
        }
        self.subscriptions.truncate(1);
        let input = if matches!(target, Target::Key(_)) {
            let input = cx.new(Secret::new);
            input.read(cx).focus.focus(window);
            self.subscriptions
                .push(cx.subscribe(&input, |this, _, _: &Submit, cx| this.save(cx)));
            Input::Secret(input)
        } else {
            let input = cx.new(Composer::new);
            input.update(cx, |input, cx| {
                input.focus = input.focus.clone().tab_stop(true);
                input.replace_text_in_range(None, text, window, cx)
            });
            input.read(cx).focus.focus(window);
            self.subscriptions
                .push(cx.subscribe(&input, |this, _, _: &Submit, cx| this.save(cx)));
            Input::Text(input)
        };
        self.editor = Some(Editor { target, input });
        self.error = None;
        self.conflict = false;
        self.changed(cx);
    }
    fn edit(&mut self, field: &'static Field, window: &mut Window, cx: &mut Context<Self>) {
        if self.locked(field) {
            return;
        }
        let _ = window;
        self.open_field = Some(field);
        self.load(false, cx);
    }

    fn write(&mut self, method: &'static str, keys: bool, body: Value, cx: &mut Context<Self>) {
        if self.busy || self.uncertain {
            return;
        }
        self.busy = true;
        self.error = None;
        self.note = "Saving settings…".into();
        let bot_choice_write = !keys
            && (body.get("botRailEnabledIds").is_some() || body.get("settingsToml").is_some());
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            if keys {
                #[derive(Deserialize)]
                struct Receipt { warning: Option<String> }
                let receipt: Receipt = client.settings_request(method, KEYS, body)?;
                let mut result = Self::read(&client, true).map_err(|_| RequestError {
                    status: None, message: "The action was accepted, but current key presence is unavailable. Refresh before trying again.".into(),
                })?;
                if let Data::Keys(_, warning) = &mut result { *warning = receipt.warning.is_some(); }
                Ok(result)
            } else {
                let _: serde::de::IgnoredAny = client.settings_request(method, DEFAULTS, body)?;
                // Invalidate as soon as the save is accepted, independently
                // of this view's lifetime and of the following readback.
                if bot_choice_write { crate::settings_fields::bot_rail_changed(&client); }
                Self::read(&client, false).map_err(|_| RequestError {
                    status: None, message: "The change was accepted, but current settings are unavailable. Refresh before trying again.".into(),
                })
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| this.receive(result, true, cx));
        })
        .detach();
        self.changed(cx);
    }
    fn set(&mut self, field: &'static Field, value: Value, cx: &mut Context<Self>) {
        if !self.locked(field) {
            let revision = self
                .snapshot
                .as_ref()
                .and_then(|s| s.toml.as_ref())
                .map(|t| t.revision.clone());
            self.write(
                "POST",
                false,
                json!({field.id:value,"settingsTomlRevision":revision}),
                cx,
            );
        }
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.uncertain {
            return;
        }
        let Some(editor) = self.editor.clone() else {
            return;
        };
        let text = match editor.input {
            Input::Text(input) => input.read(cx).text.clone(),
            Input::Secret(input) => input.update(cx, |s, cx| s.take(cx)),
        };
        match editor.target {
            Target::Field(field, revision) => match field.parse(&text) {
                Ok(value) => {
                    if !self.locked(field) {
                        self.write(
                            "POST",
                            false,
                            json!({field.id:value,"settingsTomlRevision":revision}),
                            cx,
                        );
                    }
                }
                Err(error) => {
                    self.error = Some(error);
                    self.changed(cx);
                }
            },
            Target::Key(provider) => {
                if text.trim().is_empty() {
                    self.error = Some("Enter a new key.".into());
                    self.changed(cx);
                    return;
                }
                self.write(
                    "POST",
                    true,
                    json!({"provider":provider,"key":text.trim()}),
                    cx,
                );
            }
            Target::File(revision) => self.write(
                "POST",
                false,
                json!({"settingsToml":text,"settingsTomlRevision":revision}),
                cx,
            ),
        }
    }
    fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.editor = None;
        self.open_field = None;
        self.confirm = None;
        self.conflict = false;
        self.error = None;
        self.subscriptions.truncate(1);
        self.focus(window);
        self.changed(cx);
    }
}
#[path = "settings_view.rs"]
mod view;

#[path = "settings_panels.rs"]
mod panels;

#[path = "settings_render.rs"]
mod render;

#[path = "settings_about.rs"]
mod about;
#[cfg(test)]
#[path = "settings_test_peer.rs"]
mod test_peer;

#[path = "settings_connections.rs"]
mod connections;

#[path = "settings_diagnostics.rs"]
mod diagnostics;

#[path = "settings_storage.rs"]
mod storage;

#[path = "settings_indexing.rs"]
mod indexing;

#[path = "settings_navigation.rs"]
mod navigation;

#[path = "settings_nav_groups.rs"]
mod nav_groups;

#[path = "settings_bots.rs"]
mod bots;
