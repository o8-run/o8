//! Review's scope: all working changes, or only the last turn's, the staged
//! or the unstaged files, read from the routes classic Review uses.
use super::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) enum Scope {
    #[default]
    All,
    LastTurn,
    Staged,
    Unstaged,
}

impl Scope {
    pub(super) const ORDER: [Scope; 4] =
        [Scope::All, Scope::LastTurn, Scope::Staged, Scope::Unstaged];
    pub(super) fn label(self) -> &'static str {
        match self {
            Scope::All => "All changes",
            Scope::LastTurn => "Last turn",
            Scope::Staged => "Staged",
            Scope::Unstaged => "Unstaged",
        }
    }
    pub(super) fn id(self) -> &'static str {
        match self {
            Scope::All => "diff-scope-all",
            Scope::LastTurn => "diff-scope-last-turn",
            Scope::Staged => "diff-scope-staged",
            Scope::Unstaged => "diff-scope-unstaged",
        }
    }
    fn empty(self) -> &'static str {
        match self {
            Scope::All => "No uncommitted changes.",
            Scope::LastTurn => "The last turn changed none of these files.",
            Scope::Staged => "No staged changes.",
            Scope::Unstaged => "No unstaged changes.",
        }
    }
}

/// The paths a changed file can show under: always the path as given, plus
/// both sides of a rename. The routes name a rename `old → new`; Git's
/// `dir/{old => new}.rs` form is read only with its braces, so a file
/// literally named `a => b.txt` stays one path.
fn sides(path: &str) -> Vec<String> {
    let mut sides = vec![path.to_owned()];
    if let Some((before, after)) = path.split_once(" → ") {
        sides.extend([before.to_owned(), after.to_owned()]);
    } else if let Some((before, after)) = path.split_once(" => ")
        && let (Some(open), Some(close)) = (before.rfind('{'), after.find('}'))
    {
        let (prefix, suffix) = (&before[..open], &after[close + 1..]);
        sides.extend(
            [&before[open + 1..], &after[..close]]
                .iter()
                .map(|part| format!("{prefix}{part}{suffix}").replace("//", "/")),
        );
    }
    sides
}

/// The changed files whose `flag` (`staged` or `unstaged`) is set, from a
/// `/api/review/workspace` body. A rename keeps both its paths, so the diff's
/// new path matches.
fn flagged(body: &Value, flag: &str) -> BTreeSet<String> {
    body["changedFiles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|file| file[flag].as_bool() == Some(true))
        .filter_map(|file| file["path"].as_str())
        .flat_map(sides)
        .collect()
}

/// The paths a scope keeps. Untracked files count as unstaged.
fn read(client: &Client, workspace: &str, scope: Scope) -> Result<BTreeSet<String>, String> {
    let body: Value = match scope {
        Scope::All => return Ok(BTreeSet::new()),
        Scope::LastTurn => client.get("/api/review/last-turn", &[("workspace", workspace)])?,
        Scope::Staged | Scope::Unstaged => client.get(
            "/api/review/workspace",
            // Fresh, so the scope agrees with the diff it filters.
            &[
                ("workspace", workspace),
                ("changesOnly", "1"),
                ("fresh", "1"),
            ],
        )?,
    };
    if let Some(error) = body["error"].as_str() {
        return Err(error.into());
    }
    Ok(match scope {
        Scope::LastTurn => body["filePaths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|path| path.as_str().map(str::to_owned))
            .collect(),
        Scope::Staged => flagged(&body, "staged"),
        _ => flagged(&body, "unstaged"),
    })
}

impl DiffSurface {
    pub(crate) fn set_scope(&mut self, scope: Scope, cx: &mut Context<Self>) {
        if self.scope == scope {
            return;
        }
        self.scope = scope;
        self.scope_paths = None;
        self.scope_error = None;
        self.read_scope(cx);
    }

    /// Reads the scope's paths again. The last paths stay until the reply,
    /// so a refresh does not empty the stack.
    pub(super) fn read_scope(&mut self, cx: &mut Context<Self>) {
        self.scope_generation += 1;
        cx.notify();
        let Target::Worktree { path, .. } = &self.target else {
            return;
        };
        if self.scope == Scope::All {
            return;
        }
        let (client, workspace, scope) = (self.client.clone(), path.clone(), self.scope);
        let generation = self.scope_generation;
        let task = cx
            .background_executor()
            .spawn(async move { read(&client, &workspace, scope) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.scope_generation != generation {
                    return;
                }
                match result {
                    Ok(paths) => {
                        this.scope_paths = Some(Rc::new(paths));
                        this.scope_error = None;
                    }
                    Err(error) => this.scope_error = Some(error),
                }
                this.painted.borrow_mut().clear();
                cx.notify();
            });
        })
        .detach();
    }

    /// The files the stack and its drawer show, in document order.
    pub(crate) fn shown(&self) -> Vec<usize> {
        let all = 0..self.document.files.len();
        if !self.stacked() || self.scope == Scope::All {
            return all.collect();
        }
        let Some(paths) = &self.scope_paths else {
            return vec![];
        };
        all.filter(|i| {
            let file = &self.document.files[*i];
            paths.contains(&file.path)
                || !file.old_path.is_empty() && paths.contains(&file.old_path)
        })
        .collect()
    }

    /// Said over a stack that still shows the last paths after a read failed,
    /// so a stale filter does not pass for a current one.
    pub(super) fn scope_stale(&self) -> Option<String> {
        let error = self.scope_error.as_ref()?;
        (self.scope != Scope::All && self.scope_paths.is_some()).then(|| {
            format!(
                "Could not refresh {}: {error}. Showing the last result.",
                self.scope.label()
            )
        })
    }

    /// Said in the stack when the scope keeps no file.
    pub(super) fn scope_note(&self) -> String {
        if let Some(error) = &self.scope_error {
            return error.clone();
        }
        if self.scope != Scope::All && self.scope_paths.is_none() {
            return format!("Reading {}…", self.scope.label());
        }
        self.scope.empty().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_and_unstaged_keep_only_their_flagged_files() {
        let body = serde_json::json!({"changedFiles": [
            {"path": "both.rs", "staged": true, "unstaged": true},
            {"path": "index.rs", "staged": true, "unstaged": false},
            {"path": "new.txt", "unstaged": true},
            {"path": "lane.rs"}
        ]});
        assert_eq!(
            flagged(&body, "staged").into_iter().collect::<Vec<_>>(),
            ["both.rs", "index.rs"]
        );
        assert_eq!(
            flagged(&body, "unstaged").into_iter().collect::<Vec<_>>(),
            ["both.rs", "new.txt"]
        );
    }

    #[test]
    fn a_rename_matches_by_either_path() {
        let body = serde_json::json!({"changedFiles": [
            {"path": "old.txt → new.txt", "staged": true, "unstaged": true},
            {"path": "src/{a => b}/lib.rs", "staged": true}
        ]});
        assert_eq!(
            flagged(&body, "staged").into_iter().collect::<Vec<_>>(),
            [
                "new.txt",
                "old.txt",
                "old.txt → new.txt",
                "src/a/lib.rs",
                "src/b/lib.rs",
                "src/{a => b}/lib.rs"
            ]
        );
        assert_eq!(
            flagged(&body, "unstaged").into_iter().collect::<Vec<_>>(),
            ["new.txt", "old.txt", "old.txt → new.txt"]
        );
        assert_eq!(
            sides("{old => new}/x.rs"),
            ["{old => new}/x.rs", "old/x.rs", "new/x.rs"]
        );
        assert_eq!(
            sides("dir/{ => sub}/x.rs"),
            ["dir/{ => sub}/x.rs", "dir/x.rs", "dir/sub/x.rs"]
        );
    }

    /// Braces in a route's `old → new` are part of the names, and ` => `
    /// without braces is part of one name.
    #[test]
    fn only_gits_brace_form_is_read_as_a_rename() {
        assert_eq!(
            sides("src/{a}.rs → src/{b}.rs"),
            ["src/{a}.rs → src/{b}.rs", "src/{a}.rs", "src/{b}.rs"]
        );
        let body = serde_json::json!({"changedFiles": [
            {"path": "src/{a}.rs → src/{b}.rs", "staged": true},
            {"path": "a => b.txt", "staged": true}
        ]});
        let staged = flagged(&body, "staged");
        assert!(
            staged.contains("src/{b}.rs"),
            "the staged rename stays shown"
        );
        assert!(staged.contains("a => b.txt"));
        assert!(!staged.contains("b.txt"), "{staged:?}");
        assert!(!staged.contains("a"), "{staged:?}");
    }
}
