use super::*;
#[path = "shortcuts/dialog.rs"]
mod dialog;
#[path = "shortcuts/editor.rs"]
mod editor;
#[path = "shortcuts/input.rs"]
mod input;
#[path = "shortcuts/keymap.rs"]
pub(crate) mod keymap;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<dialog::Dialog>>,
    scroll: gpui::ScrollHandle,
    subscription: Option<gpui::Subscription>,
    customize: Option<gpui::Subscription>,
    inputs: input::Inputs,
    /// The installed keymap and the editor's state.
    pub bindings: keymap::Model,
    pub editor: Option<Entity<editor::Editor>>,
    editor_subscription: Option<gpui::Subscription>,
    /// Bumped by each global change, so an older server answer cannot undo it.
    global_generation: u64,
    /// One global save at a time; a change made meanwhile saves after it.
    saving: bool,
    dirty: bool,
}
pub(super) const REGISTRATION: Registration = Registration {
    overlay_command: true,
    overlay: |s| {
        let runtime = &s.surfaces.shortcuts;
        runtime
            .editor
            .as_ref()
            .map(|v| v.clone().into_any_element())
            .or_else(|| runtime.view.as_ref().map(|v| v.clone().into_any_element()))
    },
    overlay_open: |s| s.surfaces.shortcuts.view.is_some() || s.surfaces.shortcuts.editor.is_some(),
    // Creating a recovered session focuses it. Defer hidden content until
    // dismissal so the active dialog keeps its current control.
    block_ensure: |s| s.surfaces.shortcuts.view.is_some() || s.surfaces.shortcuts.editor.is_some(),
    initialize: |s, _, cx| {
        let overrides = keymap::Overrides {
            global: Default::default(),
            machine: s.state.keybindings.clone(),
        };
        s.surfaces.shortcuts.bindings = keymap::Model::new(commands(s), overrides);
        let generation = s.surfaces.shortcuts.global_generation;
        let client = s.client.clone();
        let task = cx.background_executor().spawn(async move { read_global(&client) });
        cx.spawn(async move |this, cx| {
            // Offline or older servers keep this machine's and default chords.
            if let Ok(global) = task.await {
                let _ = this.update(cx, |s, cx| {
                    if s.surfaces.shortcuts.global_generation == generation {
                        s.surfaces.shortcuts.bindings.set_global(global);
                        refresh_editor(s, cx);
                    }
                });
            }
        })
        .detach();
    },
    key_down: keys,
    nav: |s, position, cx| {
        // Keyboard shortcuts open from the profile menu's Get help, as in
        // the desktop rail; the rail itself has no shortcuts button.
        let _ = position;
        s.surfaces.shortcuts.inputs.watch(cx);
        vec![]
    },
    ..Registration::new("", "Open keyboard shortcuts", |s, _, window, cx| {
        s.set_help(true, window, cx);
        None
    })
};
impl Shell {
    fn set_help(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        if open == self.surfaces.shortcuts.view.is_some() {
            return;
        }
        if open {
            self.capture(window, cx);
            let view = cx.new(|cx| dialog::Dialog {
                close_focus: cx.focus_handle(),
                list_focus: cx.focus_handle(),
                return_focus: window.focused(cx),
                scroll: self.surfaces.shortcuts.scroll.clone(),
            });
            view.read(cx).close_focus.focus(window);
            self.surfaces.shortcuts.subscription = Some(cx.subscribe_in(
                &view,
                window,
                |s, _, _: &dialog::Close, window, cx| s.set_help(false, window, cx),
            ));
            self.surfaces.shortcuts.customize = Some(cx.subscribe_in(
                &view,
                window,
                |s, _, _: &dialog::Customize, window, cx| {
                    s.set_help(false, window, cx);
                    open_editor(s, window, cx);
                },
            ));
            self.surfaces.shortcuts.view = Some(view);
        } else {
            let view = self.surfaces.shortcuts.view.take().unwrap();
            if let Some(focus) = &view.read(cx).return_focus {
                focus.focus(window);
            } else {
                self.restore_focus(window, cx);
            }
            self.surfaces.shortcuts.subscription = None;
            self.surfaces.shortcuts.customize = None;
        }
        self.revision += 1;
        cx.notify();
    }
}
fn editing(s: &Shell, window: &Window, cx: &App) -> bool {
    if s.surfaces.shortcuts.inputs.field_focused(window)
        || s.surfaces.shortcuts.inputs.terminal(window, cx).is_some()
    {
        return true;
    }
    s.active()
        .and_then(|t| s.content.get(&s.key(&t)))
        .is_some_and(|content| match content {
            Content::Session(session) => session.read(cx).shell_selection(window, cx).1,
            _ => false,
        })
}
fn keys(s: &mut Shell, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Shell>) -> bool {
    let key = event.keystroke.key.as_str();
    let m = event.keystroke.modifiers;
    let command = m.control || m.platform;
    let help_key = command && !m.alt && !m.shift && key == "/";
    if let Some(view) = s.surfaces.shortcuts.view.clone() {
        match key {
            "escape" => s.set_help(false, window, cx),
            "enter" | "space" if view.read(cx).close_focus.is_focused(window) => {
                s.set_help(false, window, cx)
            }
            "tab" => {
                let v = view.read(cx);
                if v.list_focus.is_focused(window) {
                    v.close_focus.focus(window);
                } else {
                    v.list_focus.focus(window);
                }
            }
            "/" if help_key => s.set_help(false, window, cx),
            "down" | "up" | "pagedown" | "pageup" | "home" | "end" => {
                let scroll = &view.read(cx).scroll;
                let offset = scroll.offset();
                let y = match key {
                    "down" => offset.y - px(32.),
                    "up" => offset.y + px(32.),
                    "pagedown" => offset.y - px(200.),
                    "pageup" => offset.y + px(200.),
                    "home" => px(0.),
                    _ => -scroll.max_offset().height,
                };
                scroll.set_offset(point(offset.x, y));
            }
            _ => {}
        }
        s.revision += 1;
        cx.notify();
        return true;
    }
    let select_tab = command
        && !m.shift
        && ((m.platform && !m.control && m.alt && ["left", "right"].contains(&key))
            || (!m.alt && key.parse::<usize>().is_ok_and(|i| (1..=9).contains(&i))));
    let close_tab = command && !m.alt && !m.shift && key == "w";
    let cycle_tab = m.control && !m.alt && !m.platform && key == "tab";
    if (select_tab || close_tab || cycle_tab)
        && (s.palette || s.shortcuts || registrations().iter().any(|r| (r.overlay_open)(s)))
    {
        // An open surface owns these keys before any underlying tab action.
        if s.palette || s.shortcuts || editing(s, window, cx) {
            return true;
        }
        if close_tab {
            for registration in registrations() {
                if (registration.overlay_open)(s) && (registration.key_down)(s, event, window, cx) {
                    break;
                }
            }
            return true;
        }
        // Full surfaces such as Projects explicitly dismiss on navigation.
        // A modal that stays open must keep navigation off its hidden tabs.
        for registration in registrations() {
            if (registration.overlay_open)(s) {
                (registration.after_tab)(s);
            }
        }
        if registrations().iter().any(|r| (r.overlay_open)(s)) {
            return true;
        }
    }
    let terminal = s.surfaces.shortcuts.inputs.terminal(window, cx);
    if let Some(terminal) = terminal
        && input::core_chord(event)
    {
        input::deliver_core_chord(&terminal, event, window, cx);
        return true;
    }
    if editing(s, window, cx) {
        // Text fields pass palette, Settings and legacy Ctrl+Tab chords.
        // Keep Ctrl+W from closing the editor or its underlying tab.
        return m.control && !m.alt && key == "w";
    }
    let question = !command && !m.alt && (key == "?" || (key == "/" && m.shift));
    if (help_key || question) && !s.palette {
        s.set_help(true, window, cx);
        return true;
    }
    if select_tab {
        s.capture(window, cx);
        if let Some(saved) = s
            .state
            .selected
            .as_ref()
            .and_then(|w| s.state.workspaces.get_mut(w))
            && !saved.tabs.is_empty()
        {
            saved.active = match key {
                "left" => (saved.active + saved.tabs.len() - 1) % saved.tabs.len(),
                "right" => (saved.active + 1) % saved.tabs.len(),
                _ => {
                    let index = key.parse::<usize>().unwrap() - 1;
                    if index < saved.tabs.len() {
                        index
                    } else {
                        saved.active
                    }
                }
            };
        }
        s.ensure(window, cx);
        s.restore_focus(window, cx);
        s.persist();
        s.revision += 1;
        cx.notify();
        return true;
    }
    if close_tab {
        if let Some(tab) = s.active() {
            s.content.remove(&s.key(&tab));
            let saved = s
                .state
                .workspaces
                .get_mut(s.state.selected.as_deref().unwrap_or(""))
                .unwrap();
            (tab.registration().remove)(saved, &tab);
            saved.tabs.remove(saved.active);
            saved.active = saved.active.min(saved.tabs.len().saturating_sub(1));
            s.ensure(window, cx);
            s.restore_focus(window, cx);
            s.persist();
            s.revision += 1;
            cx.notify();
        }
        return true;
    }
    false
}
const DEFAULTS: &str = "/api/panel/operator-defaults?include=native";
/// Every rebindable command: built-ins, then palette commands. Chats and
/// messages are per-session entries, not commands.
fn commands(s: &Shell) -> Vec<keymap::Command> {
    let mut commands = keymap::builtin_commands();
    for command in features::commands(s) {
        if matches!(command, Command::Session(_) | Command::Message(_)) {
            continue;
        }
        let label = command.label(&s.sessions);
        let id = palette::Entry::Surface(command).identity();
        if !label.is_empty() && !commands.iter().any(|c| c.id == id) {
            commands.push(keymap::Command {
                id,
                label,
                default: None,
            });
        }
    }
    commands
}
fn read_global(
    client: &Client,
) -> Result<std::collections::BTreeMap<String, String>, crate::settings::RequestError> {
    let data: serde_json::Value = client.settings_request("GET", DEFAULTS, serde_json::Value::Null)?;
    Ok(keymap::from_entries(
        data["values"]["nativeKeybindings"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str),
    ))
}
/// Writes global overrides through the same settings route as Settings, then
/// installs what the server kept.
fn save_global(s: &mut Shell, cx: &mut Context<Shell>) {
    s.surfaces.shortcuts.global_generation += 1;
    if s.surfaces.shortcuts.saving {
        s.surfaces.shortcuts.dirty = true;
        return;
    }
    s.surfaces.shortcuts.saving = true;
    let generation = s.surfaces.shortcuts.global_generation;
    let entries = keymap::to_entries(&s.surfaces.shortcuts.bindings.overrides.global);
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        let current: serde_json::Value = client.settings_request("GET", DEFAULTS, serde_json::Value::Null)?;
        let revision = current["settingsToml"]["revision"].clone();
        let _: serde::de::IgnoredAny = client.settings_request(
            "POST",
            DEFAULTS,
            serde_json::json!({"nativeKeybindings": entries, "settingsTomlRevision": revision}),
        )?;
        read_global(&client)
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |s, cx| {
            s.surfaces.shortcuts.saving = false;
            if std::mem::take(&mut s.surfaces.shortcuts.dirty) {
                // Writes the latest overrides, not the answer to older ones.
                save_global(s, cx);
                return;
            }
            if s.surfaces.shortcuts.global_generation != generation {
                return;
            }
            match result {
                Ok(global) => s.surfaces.shortcuts.bindings.set_global(global),
                Err(error) => {
                    s.surfaces.shortcuts.bindings.notice =
                        Some(format!("Global shortcuts were not saved: {}", error.message));
                }
            }
            refresh_editor(s, cx);
            s.revision += 1;
            cx.notify();
        });
    })
    .detach();
}
fn persist(s: &mut Shell, scope: keymap::Scope, cx: &mut Context<Shell>) {
    match scope {
        keymap::Scope::Machine => {
            s.state.keybindings = s.surfaces.shortcuts.bindings.overrides.machine.clone();
            s.persist();
        }
        keymap::Scope::Global => save_global(s, cx),
    }
}
fn refresh_editor(s: &mut Shell, cx: &mut Context<Shell>) {
    let Some(view) = s.surfaces.shortcuts.editor.clone() else {
        return;
    };
    let model = &s.surfaces.shortcuts.bindings;
    let (rows, scope, capturing, notice) = (
        model.keymap.rows.clone(),
        model.scope,
        model.capturing.clone(),
        model.notice.clone(),
    );
    view.update(cx, |editor, cx| {
        editor.rows = rows;
        editor.scope = scope;
        editor.capturing = capturing;
        editor.notice = notice;
        cx.notify();
    });
}
fn open_editor(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if s.surfaces.shortcuts.editor.is_some() {
        return;
    }
    s.capture(window, cx);
    let commands = commands(s);
    let model = &mut s.surfaces.shortcuts.bindings;
    model.set_commands(commands);
    model.cancel();
    model.notice = None;
    let view = cx.new(|cx| editor::Editor {
        rows: Vec::new(),
        scope: keymap::Scope::Global,
        capturing: None,
        notice: None,
        focus: cx.focus_handle(),
        return_focus: window.focused(cx),
        scroll: gpui::ScrollHandle::new(),
    });
    view.read(cx).focus.focus(window);
    s.surfaces.shortcuts.editor_subscription = Some(cx.subscribe_in(
        &view,
        window,
        |s, _, event: &editor::Event, window, cx| {
            let model = &mut s.surfaces.shortcuts.bindings;
            let changed = match event {
                editor::Event::Close => {
                    close_editor(s, window, cx);
                    return;
                }
                editor::Event::Begin(id) => {
                    model.begin(id);
                    None
                }
                editor::Event::Reset(id) => model.reset(id),
                editor::Event::ResetAll => model.reset_all(),
                editor::Event::Scope(scope) => {
                    model.set_scope(*scope);
                    None
                }
            };
            if let Some(scope) = changed {
                persist(s, scope, cx);
            }
            refresh_editor(s, cx);
            s.revision += 1;
            cx.notify();
        },
    ));
    s.surfaces.shortcuts.editor = Some(view);
    refresh_editor(s, cx);
    s.revision += 1;
    cx.notify();
}
fn close_editor(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let Some(view) = s.surfaces.shortcuts.editor.take() else {
        return;
    };
    s.surfaces.shortcuts.editor_subscription = None;
    s.surfaces.shortcuts.bindings.cancel();
    if let Some(focus) = &view.read(cx).return_focus {
        focus.focus(window);
    } else {
        s.restore_focus(window, cx);
    }
    s.revision += 1;
    cx.notify();
}
pub(super) enum Pre {
    Pass,
    Translate(KeyDownEvent),
    Release,
    Handled,
}
/// Runs before every shell key handler. The open editor owns the keyboard;
/// otherwise the installed keymap passes, translates, runs or releases.
pub(super) fn pre_key(
    s: &mut Shell,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Pre {
    if s.surfaces.shortcuts.editor.is_some() {
        let model = &mut s.surfaces.shortcuts.bindings;
        if model.capturing.is_some() {
            if let Some(scope) = model.capture(&event.keystroke) {
                persist(s, scope, cx);
            }
            refresh_editor(s, cx);
        } else if event.keystroke.key == "escape" {
            close_editor(s, window, cx);
        }
        return Pre::Handled;
    }
    match s.surfaces.shortcuts.bindings.keymap.route(event) {
        keymap::Route::Pass => Pre::Pass,
        keymap::Route::Release => Pre::Release,
        keymap::Route::Translate(keystroke) => Pre::Translate(KeyDownEvent {
            keystroke,
            is_held: event.is_held,
        }),
        keymap::Route::Run(id) => {
            if let Some(command) = features::commands(s)
                .into_iter()
                .find(|c| palette::Entry::Surface(c.clone()).identity() == id)
            {
                s.capture(window, cx);
                s.execute(command, window, cx);
            }
            Pre::Handled
        }
    }
}
#[cfg(test)]
#[path = "shortcuts/tests.rs"]
mod tests;
