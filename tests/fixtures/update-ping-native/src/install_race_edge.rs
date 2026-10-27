//! These hooks exist only in this fixture crate. An enrolled test replaces the
//! platform installer; all other tests retain the real updater behavior.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::Update;

type Before = Box<dyn FnOnce() + Send>;
type Installer = Box<dyn FnOnce() -> tauri_plugin_updater::Result<()> + Send>;
#[derive(Default)]
pub(crate) struct Hooks {
    pub before: Mutex<Option<Before>>,
    pub installer: Mutex<Option<Installer>>,
    pub calls: AtomicUsize,
}
pub(crate) fn before_install<R: Runtime>(app: &AppHandle<R>) {
    if let Some(hooks) = app.try_state::<Hooks>() {
        let before = hooks.before.lock().unwrap().take();
        if let Some(before) = before {
            before();
        }
    }
}
pub(crate) fn install<R: Runtime>(
    app: &AppHandle<R>,
    update: &Update,
    bytes: impl AsRef<[u8]>,
) -> tauri_plugin_updater::Result<()> {
    if let Some(hooks) = app.try_state::<Hooks>() {
        hooks.calls.fetch_add(1, Ordering::SeqCst);
        let installer = hooks.installer.lock().unwrap().take();
        return installer.map_or(Ok(()), |install| install());
    }
    update.install(bytes)
}
