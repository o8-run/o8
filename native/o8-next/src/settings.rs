//! Shared server settings, rendered in pure GPUI. Only view state lives here.
use crate::{
    client::Client,
    composer::{Composer, Submit},
    settings_fields::{FIELDS, Field, Kind},
    settings_secret::Secret,
};
use gpui::{AppContext, Context, Entity, EntityInputHandler, EventEmitter, FocusHandle, Window};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{cell::Cell, collections::BTreeMap, rc::Rc};

const DEFAULTS: &str = "/api/panel/operator-defaults";
const KEYS: &str = "/api/v2/keys";
#[derive(Debug)]
pub(crate) struct RequestError {
    pub status: Option<u16>,
    pub message: String,
}
#[derive(Deserialize)]
pub(crate) struct Snapshot {
    pub values: BTreeMap<String, Value>,
    pub sources: BTreeMap<String, String>,
    #[serde(rename = "settingsToml")]
    pub toml: Option<Toml>,
}
#[derive(Deserialize)]
pub(crate) struct Toml {
    text: String,
    revision: String,
    error: Option<String>,
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
    Field(&'static Field),
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
pub(crate) struct Settings {
    client: Client,
    pub snapshot: Option<Snapshot>,
    pub keys: Option<Inventory>,
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
    focus: FocusHandle,
    controls: BTreeMap<String, FocusHandle>,
    subscriptions: Vec<gpui::Subscription>,
    generation: u64,
    pub revision: u64,
    pub painted: Rc<Cell<u64>>,
    scroll: gpui::ScrollHandle,
}
impl EventEmitter<Close> for Settings {}
impl Settings {
    pub fn new(client: Client, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(Composer::new);
        let subscription = cx.observe(&search, |this, _, cx| this.changed(cx));
        let focus = cx.focus_handle();
        focus.focus(window);
        let mut view = Self {
            client,
            snapshot: None,
            keys: None,
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
            focus,
            controls: BTreeMap::new(),
            subscriptions: vec![subscription],
            generation: 0,
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            scroll: gpui::ScrollHandle::new(),
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
                        snapshot
                            .values
                            .retain(|id, _| FIELDS.iter().any(|f| f.id == id));
                        self.error = snapshot.toml.as_ref().and_then(|t| t.error.clone());
                        self.snapshot = Some(snapshot);
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
                        .is_some_and(|e| matches!(e.target, Target::File(_)));
                if mutation {
                    self.uncertain = error.status.is_none();
                }
                self.error = Some(error.message);
                self.open_file = false;
            }
        }
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
            let data: Snapshot = client.settings_request(
                "GET",
                "/api/panel/operator-defaults?include=values",
                Value::Null,
            )?;
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
        self.section = section;
        self.search.update(cx, |s, cx| s.clear(cx));
        self.scroll
            .set_offset(gpui::point(gpui::px(0.), gpui::px(0.)));
        self.load(false, cx);
    }
    fn locked(&self, field: &Field) -> bool {
        self.busy
            || self.uncertain
            || self.snapshot.as_ref().is_none_or(|s| {
                !s.values.contains_key(field.id)
                    || s.sources.get(field.id).is_some_and(|s| s == "env")
                    || field.id == "notificationsReviewReady"
                        && s.values
                            .get("presentationQuietMode")
                            .and_then(Value::as_bool)
                            == Some(true)
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
        let value = &self.snapshot.as_ref().unwrap().values[field.id];
        let text = match field.kind {
            Kind::Number(scale, _) => (value.as_f64().unwrap_or(0.) * scale).to_string(),
            _ => value.as_str().unwrap_or("").into(),
        };
        self.begin(Target::Field(field), &text, window, cx);
    }
    fn write(&mut self, method: &'static str, keys: bool, body: Value, cx: &mut Context<Self>) {
        if self.busy || self.uncertain {
            return;
        }
        self.busy = true;
        self.error = None;
        self.note = "Saving settings…".into();
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
            } else { client.settings_request(method, DEFAULTS, body).map(Data::Defaults) }
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
            self.write("POST", false, json!({field.id:value}), cx);
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
            Target::Field(field) => match field.parse(&text) {
                Ok(value) => self.set(field, value, cx),
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
