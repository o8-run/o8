//! Cmd-S drafts: a per-thread stack of set-aside text and attachments, saved
//! beside the thread's composer mode so it survives a restart.
use super::{Composer, controls::Stashed, mode_store};
use base64::Engine;
use gpui::{prelude::*, *};

impl Composer {
    fn has_draft(&self) -> bool {
        !self.text.trim().is_empty()
            || !self.controls.images.is_empty()
            || !self.controls.files.is_empty()
    }
    fn push_draft(&mut self, cx: &mut Context<Self>) {
        self.controls.stash.push(Stashed {
            text: self.text.clone(),
            images: std::mem::take(&mut self.controls.images),
            files: std::mem::take(&mut self.controls.files),
        });
        self.clear(cx);
    }
    /// Cmd-S: set the draft aside, or bring back the newest draft when empty.
    pub(crate) fn toggle_stash(&mut self, cx: &mut Context<Self>) {
        if self.has_draft() {
            self.push_draft(cx);
        } else if !self.controls.stash.is_empty() {
            self.apply_draft(self.controls.stash.len() - 1, cx);
        } else {
            return;
        }
        self.stash_changed(cx);
    }
    /// Brings one draft back. A typed draft goes onto the stack first.
    fn restore_stash(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if index >= self.controls.stash.len() {
            return;
        }
        if self.has_draft() {
            self.push_draft(cx);
        }
        self.apply_draft(index, cx);
        self.controls.stash_open = false;
        self.focus.focus(window);
        self.stash_changed(cx);
    }
    fn apply_draft(&mut self, index: usize, cx: &mut Context<Self>) {
        let draft = self.controls.stash.remove(index);
        self.controls.images = draft.images;
        self.controls.files = draft.files;
        self.set_text(&draft.text, cx);
        self.decode_previews(cx);
    }
    fn delete_stash(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.controls.stash.len() {
            self.controls.stash.remove(index);
            self.stash_changed(cx);
        }
    }
    fn stash_changed(&mut self, cx: &mut Context<Self>) {
        self.controls.stash_open &= !self.controls.stash.is_empty();
        self.save_stash(cx);
        self.images_changed(cx);
    }
    /// Reads this thread's saved drafts off the paint thread. Drafts stashed
    /// before the read lands stay newest.
    pub(crate) fn load_stash(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.controls.prompt.store.clone() else {
            return;
        };
        let read = cx
            .background_executor()
            .spawn(async move { mode_store::load_stash(Some(&path)) });
        self.controls.stash_save = Some(cx.spawn(async move |this, cx| {
            let result = read.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(mut saved) => {
                        saved.append(&mut this.controls.stash);
                        this.controls.stash = saved;
                    }
                    Err(error) => this.controls.error = error,
                }
                cx.notify();
            });
        }));
    }
    /// Writes the stack in order: each write waits for the load or write before
    /// it, then saves whatever the stack holds by then.
    fn save_stash(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.controls.prompt.store.clone() else {
            return;
        };
        let previous = self.controls.stash_save.take();
        self.controls.stash_save = Some(cx.spawn(async move |this, cx| {
            if let Some(previous) = previous {
                previous.await;
            }
            let Ok(stash) = this.read_with(cx, |this, _| this.controls.stash.clone()) else {
                return;
            };
            let saved = cx
                .background_executor()
                .spawn(async move { mode_store::save_stash(Some(&path), &stash) })
                .await;
            if let Err(error) = saved {
                let _ = this.update(cx, |this, cx| {
                    this.controls.error = error;
                    cx.notify();
                });
            }
        }));
    }
    /// A restored image lost its thumbnail while set aside; decode it again off
    /// the paint thread.
    fn decode_previews(&mut self, cx: &mut Context<Self>) {
        let uris: Vec<String> = self
            .controls
            .images
            .iter()
            .filter_map(|image| image["dataUri"].as_str())
            .filter(|uri| !self.controls.previews.contains_key(*uri))
            .map(str::to_owned)
            .collect();
        if uris.is_empty() {
            return;
        }
        let renderer = cx.svg_renderer();
        let task = cx.background_executor().spawn(async move {
            uris.into_iter()
                .filter_map(|uri| {
                    let (mime, data) = uri.strip_prefix("data:")?.split_once(";base64,")?;
                    let format = ImageFormat::from_mime_type(mime)?;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .ok()?;
                    let preview = Image::from_bytes(format, bytes)
                        .to_image_data(renderer.clone())
                        .ok()?;
                    Some((uri, preview))
                })
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let previews = task.await;
            let _ = this.update(cx, |this, cx| {
                this.controls.previews.extend(previews);
                cx.notify();
            });
        })
        .detach();
    }
    /// "Drafts (n)" under the composer; it opens the stack, newest first.
    pub(crate) fn stash_chip(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let count = self.controls.stash.len();
        if count == 0 {
            return None;
        }
        let theme = crate::theme::current();
        let open = self.controls.stash_open;
        let rows: Vec<_> =
            (0..count)
                .rev()
                .map(|index| {
                    let draft = &self.controls.stash[index];
                    let attached = draft.images.len() + draft.files.len();
                    let line = draft.text.lines().find(|l| !l.trim().is_empty());
                    let label = match (line, attached) {
                        (Some(line), 0) => line.trim().to_owned(),
                        (Some(line), n) => format!("{} · {n} attached", line.trim()),
                        (None, n) => format!("{n} attached"),
                    };
                    div()
                        .id(("composer-draft", index))
                        .debug_selector(move || format!("composer-draft-{index}"))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .h(px(28.))
                        .pl(px(8.))
                        .pr(px(2.))
                        .rounded(px(6.))
                        .cursor_pointer()
                        .hover(|s| s.bg(theme.hover))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.restore_stash(index, window, cx)
                        }))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.))
                                .text_color(theme.text_secondary)
                                .child(label),
                        )
                        .child(
                            div()
                                .id(("composer-draft-delete", index))
                                .debug_selector(move || format!("composer-draft-delete-{index}"))
                                .flex()
                                .items_center()
                                .justify_center()
                                .w(px(24.))
                                .h(px(24.))
                                .rounded(px(7.))
                                .cursor_pointer()
                                .text_color(theme.text_muted)
                                .hover(|s| s.bg(theme.hover))
                                .child("×")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.delete_stash(index, cx);
                                })),
                        )
                })
                .collect();
        Some(
            div()
                .flex()
                .flex_col()
                .px(px(12.))
                .pb(px(4.))
                .child(
                    div()
                        .id("composer-drafts")
                        .debug_selector(|| "composer-drafts".into())
                        .text_size(px(11.))
                        .text_color(theme.text_muted)
                        .cursor_pointer()
                        .hover(|s| s.text_color(theme.text_secondary))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.controls.stash_open = !this.controls.stash_open;
                            cx.notify();
                        }))
                        .child(format!(
                            "Drafts ({count}) · {}",
                            if cfg!(target_os = "macos") {
                                "⌘S"
                            } else {
                                "Ctrl+S"
                            }
                        )),
                )
                .when(open, |d| {
                    d.child(div().flex().flex_col().pt(px(4.)).children(rows))
                })
                .into_any_element(),
        )
    }
}
