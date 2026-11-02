//! Native counterpart of the classic per-tab localStorage mode preference.
use std::path::{Path, PathBuf};
#[cfg(test)]
pub(crate) struct TestRoot(pub PathBuf);
#[cfg(test)]
impl gpui::Global for TestRoot {}
pub(crate) fn path(server: &str, thread: &str, _cx: &gpui::App) -> Option<PathBuf> {
    #[cfg(test)]
    let root = _cx.try_global::<TestRoot>()?.0.clone();
    #[cfg(not(test))]
    let root = PathBuf::from(std::env::var_os("HOME")?).join(".o8/next/composer-modes");
    let mut hash = 0xcbf29ce484222325u64;
    for byte in server.bytes().chain([0]).chain(thread.bytes()) {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    Some(root.join(format!("{hash:016x}.json")))
}
fn load_text(path: Option<&Path>, limit: u64) -> Option<String> {
    let path = path?;
    let file = std::fs::File::open(path).ok()?;
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > limit {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}
pub(crate) fn load(path: Option<&Path>) -> Option<String> {
    let mode = load_text(path, 4096)?;
    matches!(mode.as_str(), "solo" | "fast" | "multitask").then_some(mode)
}
pub(crate) fn load_prelude(path: Option<&Path>) -> String {
    let path = path.map(|p| p.with_extension("prelude.json"));
    load_text(path.as_deref(), 128 * 1024).unwrap_or_default()
}
pub(crate) fn save_prelude(path: Option<&Path>, text: &str) -> Result<(), String> {
    let path = path.map(|p| p.with_extension("prelude.json"));
    if text.len() > 128 * 1024 {
        return Err("Queued context exceeds the native persistence limit.".into());
    }
    save(path.as_deref(), text)
        .map_err(|_| "Queued context could not be saved for the next launch.".into())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct PromptDraft {
    pub text: String,
    pub images: Vec<serde_json::Value>,
}
pub(crate) fn save_prompt_draft(path: Option<&Path>, draft: &PromptDraft) -> Result<(), String> {
    let path = path.map(|p| p.with_extension("prompt-draft.json"));
    let text = serde_json::to_string(draft).map_err(|e| e.to_string())?;
    if serde_json::to_vec(&text).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
        return Err("The restored prompt exceeds the native draft limit.".into());
    }
    save(path.as_deref(), &text).map_err(|_| "The restored prompt could not be saved.".into())
}
pub(crate) fn take_prompt_draft(path: Option<&Path>) -> Result<Option<PromptDraft>, String> {
    let path = path.map(|p| p.with_extension("prompt-draft.json"));
    let Some(text) = load_text(path.as_deref(), 32 * 1024 * 1024).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let draft = serde_json::from_str(&text)
        .map_err(|_| "The saved continuation draft could not be opened.".to_owned())?;
    // Consume once. Returning to an already edited conversation never restores over its new draft.
    save(path.as_deref(), "")
        .map_err(|_| "The restored prompt could not be marked as opened.".to_owned())?;
    Ok(Some(draft))
}
pub(crate) fn save(path: Option<&Path>, mode: &str) -> Result<(), String> {
    let Some(path) = path else {
        return Ok(());
    };
    let save = || -> Option<()> {
        if path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return None;
        }
        std::fs::create_dir_all(path.parent()?).ok()?;
        let temp = path.with_extension(format!("{}.tmp", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut file = options.open(&temp).ok()?;
        let result = file
            .write_all(&serde_json::to_vec(mode).ok()?)
            .and_then(|_| file.sync_all())
            .and_then(|_| std::fs::rename(&temp, path));
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result.ok()
    };
    save().ok_or_else(|| {
        "Mode changed for this draft, but could not be saved for the next launch.".into()
    })
}
