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

/// A thread's unsent composer text and attached file paths (#5203). Pasted
/// images stay in memory: they can be megabytes, and a relaunch drops them.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
pub(crate) struct Draft {
    pub text: String,
    #[serde(default)]
    pub files: Vec<PathBuf>,
}
/// Drafts are this size or smaller; a larger one is not kept across launches.
const DRAFT_LIMIT: usize = 1024 * 1024;
pub(crate) fn save_draft(path: Option<&Path>, draft: &Draft) -> Result<(), String> {
    let path = path.map(|p| p.with_extension("draft.json"));
    // An empty draft is written as nothing, which loads as no draft.
    let text = if draft.text.trim().is_empty() && draft.files.is_empty() {
        String::new()
    } else {
        serde_json::to_string(draft).map_err(|e| e.to_string())?
    };
    if serde_json::to_vec(&text).map_err(|e| e.to_string())?.len() > DRAFT_LIMIT {
        return Err("The draft is too large to keep across launches.".into());
    }
    save(path.as_deref(), &text).map_err(|_| "The draft could not be saved.".into())
}
pub(crate) fn load_draft(path: Option<&Path>) -> Option<Draft> {
    let path = path.map(|p| p.with_extension("draft.json"));
    let text = load_text(path.as_deref(), DRAFT_LIMIT as u64).filter(|t| !t.is_empty())?;
    serde_json::from_str(&text).ok()
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
/// The thread's last finished `!` card, beside its mode; none clears it.
pub(crate) fn save_shell_run(
    path: Option<&Path>,
    run: Option<&super::shell::SavedRun>,
) -> Result<(), String> {
    let path = path.map(|p| p.with_extension("shell.json"));
    let text = match run {
        Some(run) => serde_json::to_string(run).map_err(|e| e.to_string())?,
        None => String::new(),
    };
    save(path.as_deref(), &text)
        .map_err(|_| "The shell card could not be kept for the next launch.".into())
}
pub(crate) fn load_shell_run(path: Option<&Path>) -> Option<super::shell::SavedRun> {
    let path = path.map(|p| p.with_extension("shell.json"));
    let text = load_text(path.as_deref(), 1024 * 1024).filter(|t| !t.is_empty())?;
    serde_json::from_str(&text).ok()
}
/// Cmd-S drafts for this thread, oldest first, beside its mode and prelude.
pub(crate) fn save_stash(
    path: Option<&Path>,
    stash: &[super::controls::Stashed],
) -> Result<(), String> {
    let path = path.map(|p| p.with_extension("stash.json"));
    let text = serde_json::to_string(stash).map_err(|e| e.to_string())?;
    if serde_json::to_vec(&text).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
        return Err(
            "Drafts exceed the native draft limit. Delete a draft to save the rest.".into(),
        );
    }
    save(path.as_deref(), &text)
        .map_err(|_| "Drafts could not be saved for the next launch.".into())
}
pub(crate) fn load_stash(path: Option<&Path>) -> Result<Vec<super::controls::Stashed>, String> {
    let path = path.map(|p| p.with_extension("stash.json"));
    let Some(text) = load_text(path.as_deref(), 32 * 1024 * 1024) else {
        return Ok(vec![]);
    };
    serde_json::from_str(&text).map_err(|_| "Saved drafts could not be opened.".to_owned())
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
