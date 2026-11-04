// Both Shift keys: capture, open a new chat in the open project, and attach
// the capture through the composer's own image path, ready to type.
use super::*;
use crate::snapshot_hotkey::{self as hotkey, Chord, Mode, Monitor, Shift};
use std::{path::PathBuf, time::Instant};

/// The operating-system edges, replaceable by tests.
#[derive(Clone, Copy)]
pub(super) struct Os {
    pub permitted: fn(bool) -> bool,
    pub register: fn(async_channel::Sender<Shift>) -> Option<Monitor>,
    pub capture: fn(Mode, &std::path::Path) -> Result<(), String>,
    pub path: fn() -> Option<PathBuf>,
}
pub(super) struct Hotkey {
    pub os: Os,
    // Dropping the monitor unregisters it; the task ends with its channel.
    monitor: Option<(Monitor, gpui::Task<()>)>,
    chord: Chord,
    capturing: bool,
    pending: Option<Pending>,
}
impl Default for Hotkey {
    fn default() -> Self {
        Self {
            os: Os {
                permitted: hotkey::permitted,
                register: hotkey::register,
                capture: hotkey::capture,
                path: hotkey::capture_path,
            },
            monitor: None,
            chord: Chord::default(),
            capturing: false,
            pending: None,
        }
    }
}
#[cfg(test)]
impl Hotkey {
    pub(super) fn registered(&self) -> bool {
        self.monitor.is_some()
    }
    pub(super) fn idle(&self) -> bool {
        !self.capturing && self.pending.is_none()
    }
}
struct Pending {
    path: PathBuf,
    id: Option<String>,
    deadline: Instant,
}

struct SnapshotHotkey;
register_shell_feature!(SnapshotHotkey);
impl ShellFeature for SnapshotHotkey {
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver {
            order: 90,
            install: |s, w, cx| s.apply_snapshot_hotkey(false, w, cx),
        }]
    }
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 56,
            run: |s, _, w, cx| s.deliver_snapshot(w, cx),
        }]
    }
}

impl Shell {
    /// Registers the monitor while the setting is on and removes it when off.
    /// Without permission, macOS shows its prompt (when `prompt`) and nothing
    /// is registered.
    pub(crate) fn apply_snapshot_hotkey(
        &mut self,
        prompt: bool,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let state = self.features.get::<Hotkey>();
        if hotkey::mode() == Mode::Off {
            state.monitor = None;
            state.chord = Chord::default();
            return;
        }
        if state.monitor.is_some() {
            return;
        }
        if !(state.os.permitted)(prompt) {
            toasts::info(
                format!(
                    "The snapshot hotkey needs permission. Allow o8 under {}, then choose it again in Settings › Keyboard.",
                    hotkey::PERMISSION_PATH
                ),
                cx,
            );
            return;
        }
        let (sender, receiver) = async_channel::unbounded();
        let Some(monitor) = (state.os.register)(sender) else {
            toasts::info("The snapshot hotkey is available on macOS only.", cx);
            return;
        };
        let task = cx.spawn_in(w, async move |this, cx| {
            while let Ok(shift) = receiver.recv().await {
                if this
                    .update_in(cx, |s, w, cx| s.snapshot_shift(shift, w, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        state.monitor = Some((monitor, task));
    }
    fn snapshot_shift(&mut self, shift: Shift, w: &mut Window, cx: &mut Context<Self>) {
        let state = self.features.get::<Hotkey>();
        let mode = hotkey::mode();
        if !state.chord.shift(shift)
            || mode == Mode::Off
            || state.capturing
            || state.pending.is_some()
        {
            return;
        }
        let Some(path) = (state.os.path)() else {
            return;
        };
        state.capturing = true;
        let capture = state.os.capture;
        let task = cx
            .background_executor()
            .spawn(async move { capture(mode, &path).map(|_| path) });
        cx.spawn_in(w, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |s, w, cx| {
                let state = s.features.get::<Hotkey>();
                state.capturing = false;
                match result {
                    Ok(path) => {
                        state.pending = Some(Pending {
                            path,
                            id: None,
                            deadline: Instant::now() + Duration::from_secs(30),
                        });
                        s.deliver_snapshot(w, cx);
                    }
                    Err(error) => {
                        toasts::info(error, cx);
                    }
                }
            });
        })
        .detach();
    }
    /// Opens a new chat on the lead and attaches the capture once its composer
    /// can take images, as New chat and the inbox handoff do.
    fn deliver_snapshot(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(mut pending) = self.features.get::<Hotkey>().pending.take() else {
            return;
        };
        let name = pending
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let id = match pending.id.clone() {
            Some(id) => id,
            None => {
                cx.activate(true);
                w.activate_window();
                let Some(id) = self.start_thread(true, cx) else {
                    toasts::info(
                        format!(
                            "Open a project to use the snapshot hotkey. The capture was saved as {name}."
                        ),
                        cx,
                    );
                    return;
                };
                pending.id = Some(id.clone());
                id
            }
        };
        if self.sessions.iter().any(|session| session.id == id) {
            let tab = Tab::Session(id.clone());
            if self.active().as_ref() != Some(&tab) {
                self.execute(Command::Session(id.clone()), w, cx);
            }
            let surface = match self.content.get(&self.key(&tab)) {
                Some(Content::Session(surface)) => Some(surface.clone()),
                _ => None,
            };
            if let Some(surface) = surface {
                let attached = surface.update(cx, |surface, cx| {
                    surface.shell_open(id, cx);
                    surface.shell_attach_snapshot(pending.path.clone(), w, cx)
                });
                if attached {
                    cx.notify();
                    return;
                }
            }
        }
        if Instant::now() >= pending.deadline {
            toasts::info(
                format!("The snapshot chat did not open. The capture was saved as {name}."),
                cx,
            );
            return;
        }
        self.features.get::<Hotkey>().pending = Some(pending);
    }
}
