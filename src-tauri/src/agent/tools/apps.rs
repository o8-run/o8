//! App tools — `open_app` (launch/foreground via `open -a`, with a fuzzy
//! fallback against the installed-app inventory so third-party apps open even
//! when the spoken name isn't the exact bundle name) and `list_apps`
//! (enumerate installed applications). Both ReadOnly.

use serde_json::{json, Value};

/// Directories scanned for `.app` bundles, in display-priority order.
fn app_dirs() -> Vec<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    vec![
        std::path::PathBuf::from("/Applications"),
        std::path::PathBuf::from("/Applications/Utilities"),
        std::path::PathBuf::from(format!("{home}/Applications")),
        std::path::PathBuf::from("/System/Applications"),
        std::path::PathBuf::from("/System/Applications/Utilities"),
    ]
}

/// All installed app names (the `Foo` of `Foo.app`), deduped + sorted.
/// Scans one level into vendor folders too (e.g. `/Applications/Adobe
/// Photoshop 2026/Adobe Photoshop 2026.app`) — Launch Services only matches
/// exact names, so the fuzzy fallback needs those in its inventory.
fn installed_apps() -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut collect = |dir: &std::path::Path, recurse: bool| {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else { continue };
            if let Some(stem) = name.strip_suffix(".app") {
                if !stem.is_empty() {
                    names.push(stem.to_string());
                }
            } else if recurse && entry.path().is_dir() && !name.starts_with('.') {
                let Ok(inner) = std::fs::read_dir(entry.path()) else { continue };
                for e in inner.flatten() {
                    let f = e.file_name();
                    let Some(n) = f.to_str() else { continue };
                    if let Some(stem) = n.strip_suffix(".app") {
                        if !stem.is_empty() {
                            names.push(stem.to_string());
                        }
                    }
                }
            }
        }
    };
    for dir in app_dirs() {
        collect(&dir, true);
    }
    names.sort();
    names.dedup();
    names
}

/// Rank installed apps against a spoken/typed query. Returns matches sorted
/// best-first: exact name → name prefix → word prefix ("chrome" hits the
/// "Chrome" in "Google Chrome") → substring. Ties break toward shorter names
/// (more specific), then alphabetically. Only the top-scoring tier returns.
fn match_app<'a>(query: &str, apps: &'a [String]) -> Vec<&'a String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(u8, &'a String)> = apps
        .iter()
        .filter_map(|app| {
            let a = app.to_lowercase();
            let score = if a == q {
                4
            } else if a.starts_with(&q) {
                3
            } else if a.split_whitespace().any(|w| w.starts_with(&q)) {
                2
            } else if a.contains(&q) {
                1
            } else {
                return None;
            };
            Some((score, app))
        })
        .collect();
    scored.sort_by(|x, y| {
        y.0.cmp(&x.0)
            .then(x.1.len().cmp(&y.1.len()))
            .then(x.1.cmp(y.1))
    });
    let Some(&(top, _)) = scored.first() else { return Vec::new() };
    scored
        .into_iter()
        .filter(|&(s, _)| s == top)
        .map(|(_, app)| app)
        .collect()
}

/// Run `open -a <name>`. The name goes through argv (no shell) so it can't inject.
async fn open_dash_a(app: String) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || {
        crate::child_environment::command("open").arg("-a").arg(&app).output()
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?;
    match result {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(e) => Err(format!("open failed: {e}")),
    }
}

pub async fn open_app(args: Value) -> Result<Value, String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("name is required".into());
    }

    // 1. Direct: `open -a` matches registered app names case-insensitively,
    //    so this covers most first-party asks.
    if open_dash_a(name.clone()).await.is_ok() {
        return Ok(json!({ "success": true, "app": name }));
    }

    // 2. Fuzzy fallback against the installed inventory — covers third-party
    //    apps whose registered name differs from the spoken one ("chrome" →
    //    "Google Chrome", "studio" → "Visual Studio Code").
    let apps = tokio::task::spawn_blocking(installed_apps)
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))?;
    let candidates = match_app(&name, &apps);
    match candidates.as_slice() {
        [] => Err(format!(
            "No installed app matches '{name}'. Use list_apps to see what's installed."
        )),
        [single] => {
            let matched = (*single).clone();
            open_dash_a(matched.clone())
                .await
                .map_err(|e| format!("Could not open '{matched}': {e}"))?;
            Ok(json!({ "success": true, "app": matched, "requested": name }))
        }
        many => {
            let names: Vec<&str> = many.iter().take(5).map(|s| s.as_str()).collect();
            Err(format!(
                "'{name}' is ambiguous — did you mean one of: {}? Call open_app again with the exact name.",
                names.join(", ")
            ))
        }
    }
}

pub async fn list_apps(args: Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let mut apps = tokio::task::spawn_blocking(installed_apps)
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))?;
    if !query.is_empty() {
        apps.retain(|a| a.to_lowercase().contains(&query));
    }
    let total = apps.len();
    apps.truncate(250);
    Ok(json!({ "apps": apps, "count": total }))
}

#[cfg(test)]
mod match_app_tests {
    use super::match_app;

    fn fixture() -> Vec<String> {
        [
            "Google Chrome",
            "Chromium",
            "Visual Studio Code",
            "Safari",
            "Mail",
            "Xcode",
            "o8",
            "Notes",
            "OBS",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn spoken_shorthand_finds_the_real_app() {
        // The headline case: "open chrome" must reach Google Chrome.
        // ("Chromium" is NOT a prefix/substring match for "chrome" — chromi≠chrome.)
        let apps = fixture();
        assert_eq!(match_app("chrome", &apps), vec!["Google Chrome"]);
        assert_eq!(match_app("google", &apps), vec!["Google Chrome"]);
        // Name-prefix tier: "chromi" prefixes only Chromium.
        assert_eq!(match_app("chromi", &apps), vec!["Chromium"]);
    }

    #[test]
    fn exact_match_wins_over_everything() {
        let apps = fixture();
        assert_eq!(match_app("o8", &apps), vec!["o8"]);
    }

    #[test]
    fn word_prefix_matches_inner_words() {
        let apps = fixture();
        assert_eq!(match_app("studio", &apps), vec!["Visual Studio Code"]);
    }

    #[test]
    fn case_insensitive_and_no_match() {
        let apps = fixture();
        assert_eq!(match_app("SAFARI", &apps), vec!["Safari"]);
        assert!(match_app("doesnotexist", &apps).is_empty());
        assert!(match_app("  ", &apps).is_empty());
    }

    #[test]
    fn ambiguous_returns_all_top_ties() {
        let apps: Vec<String> = ["Slack One", "Slack Two"].iter().map(|s| s.to_string()).collect();
        assert_eq!(match_app("slack", &apps).len(), 2);
    }
}
