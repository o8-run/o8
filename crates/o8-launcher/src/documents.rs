//! Bounded queue survives server and window startup; no document content enters IPC.
#[cfg(test)]
mod transport;
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
            validation::open(&path, data)
                .ok()
                .map(|(path, _)| path)
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
}
