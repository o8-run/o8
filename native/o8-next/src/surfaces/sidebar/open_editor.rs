//! Open a thread's repository in VS Code or Cursor from the row menu, after
//! T3 Code. Local only: a thread on another machine needs an SSH remote URI.
use super::*;
use crate::shell::toasts;
use crate::theme::current as theme;
use gpui::{AnyElement, MouseButton, div, px};

/// Lucide external-link.
const OPEN: &str = "M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6";

/// Name, macOS bundle id, and the CLI used elsewhere.
const EDITORS: [(&str, &str, &str); 2] = [
    ("VS Code", "com.microsoft.VSCode", "code"),
    ("Cursor", "com.todesktop.230313mzl4w4u92", "cursor"),
];

/// The program and arguments. No shell is involved, and only an absolute path
/// is accepted, so a stored path cannot read as an option.
pub(super) fn command(
    editor: (&str, &str, &str),
    path: &str,
    macos: bool,
) -> Option<(String, Vec<String>)> {
    if !std::path::Path::new(path).is_absolute() {
        return None;
    }
    Some(if macos {
        (
            "open".into(),
            vec!["-b".into(), editor.1.into(), path.into()],
        )
    } else {
        (editor.2.into(), vec![path.into()])
    })
}

impl ThreadList {
    fn open_in_editor(
        &mut self,
        editor: (&'static str, &'static str, &'static str),
        path: String,
        cx: &mut Context<Self>,
    ) {
        let Some((program, args)) = command(editor, &path, cfg!(target_os = "macos")) else {
            return;
        };
        let task = cx.background_executor().spawn(async move {
            std::process::Command::new(program)
                .args(args)
                .status()
                .is_ok_and(|status| status.success())
        });
        cx.spawn(async move |this, cx| {
            let opened = task.await;
            let _ = this.update(cx, |_, cx| {
                if !opened {
                    toasts::show(
                        toasts::Kind::Info,
                        format!("{} is not installed.", editor.0),
                        vec![],
                        Some(toasts::NOTICE_TIMEOUT),
                        cx,
                    );
                }
            });
        })
        .detach();
    }
    /// One menu row per editor, when the thread has a local repository.
    pub(super) fn editor_items(&self, id: &str, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let Some(path) = self
            .sessions
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.repo_path.clone())
            .filter(|path| std::path::Path::new(path).is_dir())
        else {
            return vec![];
        };
        EDITORS
            .into_iter()
            .map(|editor| {
                let path = path.clone();
                div()
                    .id(editor.0)
                    .debug_selector(move || format!("sidebar-row-open-{}", editor.2))
                    .h(px(28.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(7.))
                    .text_size(px(12.5))
                    .cursor_pointer()
                    .hover(|s| s.bg(theme().hover))
                    .child(crate::icon::stroke(OPEN, theme().text_muted, 14., 1.7))
                    .child(format!("Open in {}", editor.0))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.row_menu = None;
                        this.open_in_editor(editor, path.clone(), cx);
                        cx.notify();
                    }))
                    .into_any_element()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{EDITORS, command};

    #[test]
    fn the_editor_command_takes_only_an_absolute_path() {
        let (program, args) = command(EDITORS[0], "/repo", true).unwrap();
        assert_eq!(program, "open");
        assert_eq!(args, ["-b", "com.microsoft.VSCode", "/repo"]);
        let (program, args) = command(EDITORS[1], "/repo", false).unwrap();
        assert_eq!((program.as_str(), args.as_slice()), ("cursor", &["/repo".to_owned()][..]));
        assert!(command(EDITORS[0], "--new-window", true).is_none());
    }
}
