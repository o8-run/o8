//! Workspace Notes: the classic repo-spec read, 800ms autosave and conflict contract.
use super::{editor::Editor, io};
use crate::{client::Client, theme::current as theme};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
#[path = "spec_controls.rs"]
mod controls;
#[path = "spec_preferences.rs"]
mod preferences;
#[path = "spec_settings.rs"]
mod settings;
#[path = "spec_target.rs"]
mod target;
#[path = "spec_view.rs"]
mod view;
pub(super) use preferences::Changed as PreferencesChanged;
pub use preferences::Preferences;
impl EventEmitter<PreferencesChanged> for Spec {}
struct Conflict {
    content: String,
    hash: Option<String>,
}
pub(super) struct Spec {
    client: Client,
    pub(super) editor: Entity<Editor>,
    pub(super) focus: FocusHandle,
    workspace: String,
    default_workspace: String,
    preferences: Preferences,
    target: target::Target,
    settings: bool,
    settings_focus: FocusHandle,
    hue_bounds: Bounds<Pixels>,
    content: String,
    loaded: String,
    server: String,
    hash: Option<String>,
    loading: bool,
    saving: bool,
    pending: bool,
    saved: Option<Instant>,
    error: Option<String>,
    conflict: Option<Conflict>,
    started: bool,
    loaded_once: bool,
    active: bool,
    generation: u64,
    edits: u64,
    _editor: Subscription,
}
impl Spec {
    pub(super) fn new(client: Client, workspace: String, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| {
            let mut e = Editor::new("", cx);
            e.notes = true;
            e.context = "NotesEditor";
            e
        });
        let focus = cx.focus_handle();
        let observed = cx.observe(&editor, |this, _, cx| this.changed(cx));
        let target = target::Target::new(cx);
        Self {
            client,
            default_workspace: workspace.clone(),
            preferences: Preferences::default(),
            target,
            settings: false,
            settings_focus: cx.focus_handle(),
            hue_bounds: Bounds::default(),
            editor,
            focus,
            workspace,
            content: String::new(),
            loaded: String::new(),
            server: String::new(),
            hash: None,
            loading: true,
            saving: false,
            pending: false,
            saved: None,
            error: None,
            conflict: None,
            started: false,
            loaded_once: false,
            active: true,
            generation: 0,
            edits: 0,
            _editor: observed,
        }
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        let next = self.editor.read(cx).text.clone();
        if self.content != next {
            self.content = next;
            self.saved = None;
            if self.conflict.is_none() {
                self.schedule_save(cx);
            } else {
                self.pending = false;
            }
        }
        cx.notify();
    }
    fn schedule_save(&mut self, cx: &mut Context<Self>) {
        self.edits += 1;
        let edits = self.edits;
        let generation = self.generation;
        self.pending = true;
        let timer = cx.background_executor().timer(Duration::from_millis(800));
        cx.spawn(async move |this, cx| {
            timer.await;
            let _ = this.update(cx, |this, cx| {
                if generation == this.generation && edits == this.edits {
                    this.persist(false, cx);
                }
            });
        })
        .detach();
    }
    fn adopt(
        &mut self,
        content: String,
        hash: Option<String>,
        baseline: bool,
        cx: &mut Context<Self>,
    ) {
        self.content = content.clone();
        self.server = content.clone();
        self.hash = hash;
        if baseline {
            self.loaded = content.clone();
        }
        let initial = !self.loaded_once;
        self.loaded_once = true;
        self.editor.update(cx, |editor, cx| {
            if initial {
                editor.initial_text(&content, cx);
            } else if editor.text != content {
                editor.set_text(&content, cx);
            }
        });
    }
    pub(super) fn load(&mut self, background: bool, cx: &mut Context<Self>) {
        if background
            && (!self.active
                || self.loading
                || self.pending
                || self.saving
                || self.content != self.server)
        {
            return;
        }
        if self.workspace.is_empty() {
            self.loading = false;
            self.error = Some("Select a repo to edit o8.md.".into());
            cx.notify();
            return;
        }
        if !background {
            self.loading = true;
            self.error = None;
        }
        let generation = self.generation;
        let client = self.client.clone();
        let repo = self.workspace.clone();
        let work = cx.background_executor().spawn(async move {
            io::json_request(
                &client,
                "GET",
                "/api/repo-spec",
                &[("repoPath", &repo)],
                None,
            )
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                if background
                    && (!this.active || this.pending || this.saving || this.content != this.server)
                {
                    return;
                }
                if !background {
                    this.loading = false;
                }
                match result {
                    Ok((status, body)) if status < 300 && body["ok"] == true => {
                        let content = body["content"].as_str().unwrap_or("").to_owned();
                        let hash = (body["exists"] != false)
                            .then(|| body["contentHash"].as_str().map(str::to_owned))
                            .flatten();
                        if this.server != content || !background {
                            this.adopt(content, hash, true, cx);
                        } else {
                            this.hash = hash;
                        }
                        this.error = None;
                    }
                    Ok((_, body)) if !background => {
                        this.error = Some(
                            body["error"]
                                .as_str()
                                .unwrap_or("Failed to load notes")
                                .into(),
                        )
                    }
                    Err(error) if !background => this.error = Some(error),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn persist(&mut self, force: bool, cx: &mut Context<Self>) {
        if self.workspace.is_empty()
            || self.loading
            || !self.loaded_once
            || self.saving
            || self.conflict.is_some() && !force
        {
            return;
        }
        if !force && self.content == self.server {
            self.pending = false;
            cx.notify();
            return;
        }
        self.saving = true;
        self.pending = true;
        self.error = None;
        let snapshot = self.content.clone();
        let sent = snapshot.clone();
        let generation = self.generation;
        let client = self.client.clone();
        let repo = self.workspace.clone();
        let mut body = json!({"content":snapshot});
        if let Some(hash) = &self.hash {
            body["expectedHash"] = json!(hash);
        }
        if force {
            body["force"] = json!(true);
        }
        let work = cx.background_executor().spawn(async move {
            io::json_request(
                &client,
                "PUT",
                "/api/repo-spec",
                &[("repoPath", &repo)],
                Some(body),
            )
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this.saving = false;
                this.pending = false;
                match result {
                    Ok((status, body)) if status < 300 && body["ok"] == true => {
                        let saved = body["content"].as_str().unwrap_or(&sent).to_owned();
                        this.server = saved.clone();
                        this.hash = body["contentHash"].as_str().map(str::to_owned);
                        this.conflict = None;
                        this.saved = Some(Instant::now());
                        if this.content == sent {
                            this.content = saved.clone();
                            this.editor.update(cx, |e, cx| {
                                if e.text != saved {
                                    e.set_text(&saved, cx);
                                }
                            });
                        } else {
                            this.schedule_save(cx);
                        }
                    }
                    Ok((409, body)) if body["error"] == "changed-on-disk" => {
                        this.edits += 1;
                        this.conflict = Some(Conflict {
                            content: body["content"].as_str().unwrap_or("").into(),
                            hash: body["contentHash"].as_str().map(str::to_owned),
                        });
                    }
                    Ok((_, body)) => {
                        this.error = Some(body["error"].as_str().unwrap_or("Save failed").into())
                    }
                    Err(error) => this.error = Some(error),
                }
                if !this.pending && this.error.is_none() && this.conflict.is_none() {
                    let target = this
                        .preferences
                        .target_override
                        .as_deref()
                        .unwrap_or(&this.default_workspace);
                    if this.workspace != target {
                        this.change_target(cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn reload_conflict(&mut self, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        if let Some(conflict) = self.conflict.take() {
            self.edits += 1;
            self.pending = false;
            self.error = None;
            self.saved = None;
            self.adopt(conflict.content, conflict.hash, true, cx);
            cx.notify();
        }
    }
    pub(super) fn follow_workspace(&mut self, workspace: &str, cx: &mut Context<Self>) {
        if self.default_workspace == workspace {
            return;
        }
        self.default_workspace = workspace.into();
        if self.preferences.target_override.is_none()
            && !self.pending
            && !self.saving
            && self.content == self.server
        {
            self.change_target(cx);
        }
    }
    pub(super) fn active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.active != active {
            self.active = active;
            if active && self.started {
                self.load(true, cx);
            }
        }
    }
    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.started {
            return;
        }
        self.started = true;
        self.target._submit = Some(cx.subscribe_in(
            &self.target.input,
            window,
            |this, _, _: &crate::composer::Submit, window, cx| {
                let path = this.target.input.read(cx).text.clone();
                this.select_target(path, window, cx);
            },
        ));
        self.load(false, cx);
        let handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(4)).await;
                let visible = handle
                    .update(cx, |_, window, _| window.is_window_active())
                    .unwrap_or(false);
                if this
                    .update(cx, |this, cx| {
                        if visible {
                            this.load(true, cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }
    fn status(&self) -> String {
        if self.loading {
            "Loading notes".into()
        } else if let Some(error) = &self.error {
            error.clone()
        } else if self.pending {
            "Saving...".into()
        } else if let Some(saved) = self.saved {
            let seconds = saved.elapsed().as_secs();
            if seconds < 60 {
                format!("Saved {seconds}s ago")
            } else {
                format!("Saved {}m ago", seconds / 60)
            }
        } else {
            "Loaded".into()
        }
    }
    fn diff(&self) -> (usize, usize) {
        if self.content == self.loaded {
            return (0, 0);
        }
        let normalize = |s: &str| {
            s.replace("\r\n", "\n")
                .split('\n')
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        let before = normalize(&self.loaded);
        let after = normalize(&self.content);
        let mut start = 0;
        while start < before.len().min(after.len()) && before[start] == after[start] {
            start += 1;
        }
        let mut old = before.len();
        let mut new = after.len();
        while old > start && new > start && before[old - 1] == after[new - 1] {
            old -= 1;
            new -= 1;
        }
        (new - start, old - start)
    }
}
