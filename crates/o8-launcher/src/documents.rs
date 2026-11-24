//! Bounded queue survives server and window startup; no document content enters IPC.
//! Opened folders share it and open as projects in the window.
// One copy of the path rules and the wire format, shared with the native window.
// It lives in the native window's sources so that crate still builds when its
// source folder is copied on its own.
#[cfg(test)]
#[path = "../../../native/o8-next/src/document_transport.rs"]
mod transport;
#[path = "../../../native/o8-next/src/document_validation.rs"]
pub mod validation;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
};
static PATHS: Mutex<VecDeque<PathBuf>> = Mutex::new(VecDeque::new());
pub fn initial() -> Vec<PathBuf> {
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg.to_string_lossy().starts_with('-'))
    {
        return Vec::new();
    }
    std::env::args_os()
        .skip(1)
        .filter(|p| !p.to_string_lossy().starts_with('-'))
        .take(32)
        .map(PathBuf::from)
        .collect()
}
pub fn enqueue(path: PathBuf) {
    let mut paths = PATHS.lock().unwrap();
    if paths.len() < 32 && !paths.contains(&path) {
        paths.push_back(path);
    }
}
pub fn pending() -> bool {
    !PATHS.lock().unwrap().is_empty()
}
pub fn take(data: &Path) -> Vec<PathBuf> {
    PATHS
        .lock()
        .unwrap()
        .drain(..)
        .filter_map(|path| {
            // A folder opens as a project; a file opens in the viewer.
            if path.is_dir() {
                validation::folder(&path, data).ok()
            } else {
                validation::open(&path, data).ok().map(|(path, _)| path)
            }
            .filter(|p| p.to_str().is_some())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finder_documents_survive_startup_and_control_handoff() {
        use crate::control::{Instance, Request};
        use std::{
            io::Write,
            time::{Duration, Instant},
        };
        let root = PathBuf::from("/tmp").join(format!("o8-documents-{}", std::process::id()));
        std::fs::create_dir_all(root.join("data")).unwrap();
        let file = root.join("guide.md");
        std::fs::write(&file, "# Guide").unwrap();
        let instance = Instance::claim(&root.join("data")).unwrap().unwrap();
        enqueue(file.clone());
        enqueue(file.clone());
        // A second executable invocation must deliver arguments, not merely Show.
        let second_file = root.join("second.md");
        std::fs::write(&second_file, "# Second").unwrap();
        let data = root.join("data");
        let second_path = second_file.clone();
        let second = std::thread::spawn(move || {
            assert!(Instance::claim_with(&data, &[second_path])
                .unwrap()
                .is_none());
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some((Request::OpenFiles { paths }, Some(mut peer))) =
                instance.receive().unwrap()
            {
                for path in paths {
                    enqueue(path);
                }
                writeln!(peer, "{{\"ok\":true}}").unwrap();
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        second.join().unwrap();
        let data = root.join("data");
        let child = std::thread::spawn(move || transport::receive(&data).unwrap());
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some((request, Some(mut peer))) = instance.receive().unwrap() {
                assert!(matches!(request, Request::TakeOpenFiles));
                writeln!(
                    peer,
                    "{}",
                    serde_json::json!({"paths": take(&root.join("data"))})
                )
                .unwrap();
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            child.join().unwrap(),
            vec![
                std::fs::canonicalize(file).unwrap(),
                std::fs::canonicalize(second_file).unwrap()
            ]
        );
        assert!(take(&root.join("data")).is_empty());
        drop(instance);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_opened_folder_reaches_the_window_and_a_private_one_does_not() {
        let root = PathBuf::from("/tmp").join(format!("o8-open-folder-{}", std::process::id()));
        use std::os::unix::fs::PermissionsExt;
        // Explicit modes: a test running beside this one may change the umask.
        for name in ["", "data", "repo", ".ssh"] {
            let dir = root.join(name);
            let _ = std::fs::create_dir(&dir);
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let _ = take(&root.join("data"));
        for name in ["repo", ".ssh", "data"] {
            enqueue(root.join(name));
        }
        assert_eq!(
            take(&root.join("data")),
            vec![std::fs::canonicalize(root.join("repo")).unwrap()]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
