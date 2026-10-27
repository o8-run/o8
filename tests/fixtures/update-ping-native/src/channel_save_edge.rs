//! Per-path atomic preferences faults exist only in the native fixture.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
type Fault = Box<dyn FnOnce(&Path) -> Result<(), String> + Send>;
fn faults() -> &'static Mutex<HashMap<PathBuf, Fault>> {
    static FAULTS: OnceLock<Mutex<HashMap<PathBuf, Fault>>> = OnceLock::new();
    FAULTS.get_or_init(Mutex::default)
}
pub(crate) fn fail(path: &Path, fault: Fault) {
    faults().lock().unwrap().insert(path.to_owned(), fault);
}
pub(crate) fn before_commit(path: &Path, temporary: &Path) -> Result<(), String> {
    let fault = faults().lock().unwrap().remove(path);
    fault.map_or(Ok(()), |fault| fault(temporary))
}
pub(crate) fn fail_commits(path: &Path, count: usize) {
    let target = path.to_owned();
    fail(
        path,
        Box::new(move |temporary| {
            std::fs::write(temporary, b"{\"channel\":").unwrap();
            if count > 1 {
                fail_commits(&target, count - 1);
            }
            Err("fixture preferences commit failure".into())
        }),
    );
}
