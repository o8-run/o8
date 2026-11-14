use crate::cli_locate;
pub fn augment_process_path(login_path: &str) {
    if login_path.is_empty() {
        log::warn!(
            "Could not resolve login-shell PATH; falling back to the well-known \
             CLI dirs + minimal Finder PATH for sidecar children"
        );
    }
    let current = std::env::var("PATH").unwrap_or_default();
    let well_known = cli_locate::well_known_cli_bin_dirs();
    // PATH entries are ':'-delimited on Unix, ';'-delimited on Windows —
    // `current` is a real inherited PATH on both platforms, so this has to
    // match the OS or every Windows PATH collapses into one bogus entry.
    let path_sep = if cfg!(windows) { ';' } else { ':' };
    let mut merged: Vec<String> = Vec::new();
    for entry in login_path
        .split(path_sep)
        .chain(current.split(path_sep))
        .map(str::to_string)
        .chain(well_known.into_iter())
    {
        if !entry.is_empty() && !merged.contains(&entry) {
            merged.push(entry);
        }
    }
    let entry_count = merged.len();
    let merged = merged.join(&path_sep.to_string());
    log::info!(
        "Augmented PATH from login shell + well-known CLI dirs ({} entries) for sidecar children",
        entry_count
    );
    std::env::set_var("PATH", merged);
}

