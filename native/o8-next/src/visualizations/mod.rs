//! Inline transcript documents. The host never exposes application requests to HTML.
#[cfg(target_os = "macos")]
pub mod macos;
pub mod protocol;
use crate::client::Client;
use protocol::{Message, Reference, UNAVAILABLE, valid_state};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
    rc::Rc,
    sync::mpsc,
    time::Instant,
};

pub type Cards = HashMap<String, Rc<RefCell<Card>>>;
pub struct Card {
    pub reference: Reference,
    pub height: f64,
    pub error: Option<String>,
    pub ready: bool,
    pub nonce: String,
    pub bounds: Option<gpui::Bounds<gpui::Pixels>>,
    client: Client,
    loading: Option<mpsc::Receiver<Result<String, String>>>,
    started: Option<Instant>,
    source: Option<String>,
    state: Value,
    state_file: Option<PathBuf>,
    dirty: bool,
    leases: usize,
    #[cfg(target_os = "macos")]
    host: Option<Rc<macos::Host>>,
    #[cfg(target_os = "macos")]
    sent_theme: Option<Value>,
}
fn state_file(reference: &Reference) -> Option<PathBuf> {
    let directory = std::env::var_os("O8_NEXT_VIEW_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| PathBuf::from(home).join(".o8/next/visualization-views"))
        })?;
    Some(directory.join(format!("{}.json", reference.state_id())))
}
fn read_state(path: &std::path::Path) -> Value {
    let mut bytes = vec![];
    if let Ok(input) = fs::File::open(path) {
        if input.take(16 * 1024 + 1).read_to_end(&mut bytes).is_ok() && bytes.len() <= 16 * 1024 {
            if let Ok(state) = serde_json::from_slice::<Value>(&bytes) {
                if valid_state(&state) {
                    return state;
                }
            }
        }
    }
    json!({})
}
fn save_state(path: &std::path::Path, state: &Value) {
    if !valid_state(state)
        || path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
    {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(&temp) {
        if file.write_all(state.to_string().as_bytes()).is_ok() {
            let _ = fs::rename(&temp, path);
        }
        let _ = fs::remove_file(temp);
    }
}
impl Card {
    pub fn new(reference: Reference, client: Client) -> Self {
        let state_file = state_file(&reference);
        let state = state_file
            .as_deref()
            .map(read_state)
            .unwrap_or_else(|| json!({}));
        let mut random = [0u8; 24];
        let entropy = getrandom::fill(&mut random).is_ok();
        Self {
            height: reference.height,
            reference,
            client,
            state_file,
            state,
            nonce: random.iter().map(|b| format!("{b:02x}")).collect(),
            error: (!entropy || !cfg!(target_os = "macos")).then(|| UNAVAILABLE.into()),
            ready: false,
            loading: None,
            started: None,
            source: None,
            bounds: None,
            dirty: false,
            leases: 0,
            #[cfg(target_os = "macos")]
            host: None,
            #[cfg(target_os = "macos")]
            sent_theme: None,
        }
    }
    pub fn display_height(&self) -> f32 {
        if self.error.is_some() {
            if cfg!(target_os = "macos") { 96. } else { 114. }
        } else {
            self.height as f32
        }
    }
    pub fn start(&mut self) {
        if self.error.is_some() || self.started.is_some() {
            return;
        }
        let client = self.client.clone();
        let reference = self.reference.clone();
        let nonce = self.nonce.clone();
        let (send, receive) = mpsc::channel();
        self.loading = Some(receive);
        self.started = Some(Instant::now());
        std::thread::spawn(move || {
            let result = document(&client, &reference, &nonce);
            let _ = send.send(result);
            client.wake();
        });
    }
    pub fn retry(&mut self) {
        let reference = self.reference.clone();
        let client = self.client.clone();
        let leases = self.leases;
        *self = Self::new(reference, client);
        self.leases = leases;
        self.start();
    }
    pub fn poll(&mut self) -> bool {
        let mut changed = std::mem::take(&mut self.dirty);
        if let Some(result) = self.loading.as_ref().and_then(|r| r.try_recv().ok()) {
            self.loading = None;
            match result {
                Ok(source) => {
                    self.source = Some(source);
                    self.started = Some(Instant::now());
                }
                Err(error) => self.error = Some(error),
            }
            changed = true;
        }
        #[cfg(target_os = "macos")]
        if let Some(host) = &self.host {
            let mut events = host.events.borrow_mut();
            changed |= events.finished && self.sent_theme.is_none() && self.leases > 0;
            if events.failed && self.error.is_none() {
                self.error = Some(UNAVAILABLE.into());
                changed = true;
                host.hide();
            }
            for event in events.messages.drain(..) {
                match event {
                    Message::Height(height) => {
                        changed |= self.height != height || !self.ready;
                        self.height = height;
                        self.ready = true;
                        let theme = crate::theme::visualization();
                        host.send("theme", "theme", &theme);
                        self.sent_theme = Some(theme);
                        host.send("state", "value", &self.state);
                    }
                    Message::State(state) => {
                        if state != self.state {
                            self.state = state;
                            if let Some(file) = &self.state_file {
                                save_state(file, &self.state);
                            }
                        }
                    }
                }
            }
        }
        if !self.ready
            && self.error.is_none()
            && self
                .started
                .is_some_and(|start| start.elapsed().as_secs() >= 12)
        {
            self.error = Some("The visualization did not finish loading. Try again.".into());
            changed = true;
        }
        changed
    }
    pub fn paint(
        &mut self,
        bounds: gpui::Bounds<gpui::Pixels>,
        clip: gpui::Bounds<gpui::Pixels>,
        window: &gpui::Window,
    ) {
        self.bounds = Some(bounds);
        self.start();
        #[cfg(target_os = "macos")]
        {
            if self.error.is_some() {
                if let Some(host) = &self.host {
                    host.hide();
                }
                return;
            }
            if self.host.is_none()
                && let Some(source) = &self.source
            {
                let client = self.client.clone();
                self.host =
                    macos::Host::new(source, &self.nonce, window, Rc::new(move || client.wake()))
                        .map(Rc::new);
                if self.host.is_none() {
                    self.error = Some(UNAVAILABLE.into());
                    self.dirty = true;
                    self.client.wake();
                }
            }
            if let Some(host) = &self.host {
                host.position(bounds, clip, window);
                if !self.ready {
                    host.hide();
                }
                let theme = crate::theme::visualization();
                if host.events.borrow().finished && self.sent_theme.as_ref() != Some(&theme) {
                    host.send("theme", "theme", &theme);
                    host.send("state", "value", &self.state);
                    self.sent_theme = Some(theme);
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (bounds, clip, window);
    }
    pub fn hide(&self) {
        #[cfg(target_os = "macos")]
        if let Some(host) = &self.host {
            host.hide();
        }
    }
}
fn document(client: &Client, reference: &Reference, nonce: &str) -> Result<String, String> {
    let mut url = client
        .url(&format!("/api/visualizations/{}", reference.id))
        .map_err(|_| UNAVAILABLE)?;
    url.query_pairs_mut().append_pair("nativeNonce", nonce);
    let response = match client.request("GET", &url).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => {
            let body: Value = Client::read(response).unwrap_or(Value::Null);
            return Err(body["error"]["message"]
                .as_str()
                .filter(|s| s.len() <= 500)
                .unwrap_or(UNAVAILABLE)
                .to_owned());
        }
        Err(_) => return Err(UNAVAILABLE.into()),
    };
    let body: Value = Client::read(response)?;
    let reference_read = Reference::parse(&body["result"]["visualization"]).ok_or(UNAVAILABLE)?;
    if reference_read.id != reference.id {
        return Err(UNAVAILABLE.into());
    }
    body["result"]["sealedHtml"]
        .as_str()
        .filter(|html| html.len() <= 12 * 1024 * 1024)
        .map(str::to_owned)
        .ok_or_else(|| UNAVAILABLE.into())
}
// GPUI retains this lease with the rendered element state, including cached scenes.
// Removing the card, tab, pane or window drops the lease and hides its native pixels.
pub struct Lease(pub Vec<Rc<RefCell<Card>>>);
impl Lease {
    pub fn new(cards: Vec<Rc<RefCell<Card>>>) -> Self {
        for card in &cards {
            card.borrow_mut().leases += 1;
        }
        Self(cards)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        for card in &self.0 {
            let mut card = card.borrow_mut();
            card.leases -= 1;
            if card.leases == 0 {
                card.hide();
            }
        }
    }
}
