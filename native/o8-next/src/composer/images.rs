//! Manual paste, file picker and OS drop share the desktop's four-image/5 MiB limits.
//! Other files (a screen recording, a log, a PDF) attach by path: the agent opens
//! them from disk, since the runtimes take pictures but not video.
use super::Composer;
use base64::Engine;
use gpui::{prelude::*, *};
use serde_json::json;
use std::{fs, io::Read, path::PathBuf, sync::Arc};

const MAX_IMAGES: usize = 4;
const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_FILES: usize = 8;
const VIDEO: &[&str] = &["mov", "mp4", "m4v", "webm", "mkv", "avi"];
pub(crate) struct ImagesChanged;
impl EventEmitter<ImagesChanged> for Composer {}
enum Input {
    Clipboard(Image),
    Path(PathBuf),
}

impl Composer {
    pub(crate) fn attach_clipboard(&mut self, item: &ClipboardItem, cx: &mut Context<Self>) {
        let inputs: Vec<_> = item
            .entries()
            .iter()
            .filter_map(|entry| match entry {
                ClipboardEntry::Image(image) => Some(Input::Clipboard(image.clone())),
                _ => None,
            })
            .collect();
        if !inputs.is_empty() {
            self.controls.error.clear();
        }
        self.attach_images(inputs, cx);
    }
    pub(crate) fn attach_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        // One batch owns its feedback. Accepting an image must not clear a
        // rejection from another item in the same picker or drop operation.
        self.controls.error.clear();
        let (images, files): (Vec<_>, Vec<_>) = paths.into_iter().partition(|path| {
            matches!(
                extension(path).as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp"
            )
        });
        self.attach_files(files, cx);
        self.attach_images(images.into_iter().map(Input::Path).collect(), cx);
    }
    fn attach_files(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        for path in paths {
            if !path.is_file() {
                self.controls.error = "Choose a file, not a folder.".into();
            } else if self.controls.files.len() >= MAX_FILES {
                self.controls.error =
                    "Attach at most 8 files. Remove a file before retrying.".into();
                break;
            } else if !self.controls.files.contains(&path) {
                self.controls.files.push(path);
            }
        }
        self.images_changed(cx);
    }
    pub(crate) fn remove_file(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if index < self.controls.files.len() {
            self.controls.files.remove(index);
            let next = (index < self.controls.files.len())
                .then(|| {
                    self.controls
                        .focus
                        .get(&format!("composer-file-remove-{index}"))
                })
                .flatten();
            next.unwrap_or(&self.focus).focus(window);
            self.images_changed(cx);
        }
    }
    fn images_changed(&mut self, cx: &mut Context<Self>) {
        cx.notify();
        cx.emit(ImagesChanged);
    }
    fn attach_images(&mut self, inputs: Vec<Input>, cx: &mut Context<Self>) {
        if inputs.is_empty() {
            return;
        }
        if !self.controls.images_enabled {
            self.controls.error = "The selected runtime cannot receive images.".into();
            self.images_changed(cx);
            return;
        }
        if self.controls.images.len() + self.controls.pending_images + inputs.len() > MAX_IMAGES {
            self.controls.error =
                "Attach at most 4 images. Remove an image before retrying.".into();
            self.images_changed(cx);
            return;
        }
        let count = inputs.len();
        self.controls.pending_images += count;
        self.images_changed(cx);
        let renderer = cx.svg_renderer();
        let task = cx.background_executor().spawn(async move {
            inputs
                .into_iter()
                .map(|input| {
                    let (name, image) = match input {
                        Input::Clipboard(image) => (
                            format!(
                                "Clipboard.{}",
                                match image.format {
                                    ImageFormat::Png => "png",
                                    ImageFormat::Jpeg => "jpg",
                                    ImageFormat::Gif => "gif",
                                    ImageFormat::Webp => "webp",
                                    _ => return Err("Choose a PNG, JPEG, WebP or GIF image."),
                                }
                            ),
                            image,
                        ),
                        Input::Path(path) => {
                            let format = match path
                                .extension()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_ascii_lowercase()
                                .as_str()
                            {
                                "png" => ImageFormat::Png,
                                "jpg" | "jpeg" => ImageFormat::Jpeg,
                                "gif" => ImageFormat::Gif,
                                "webp" => ImageFormat::Webp,
                                _ => return Err("Choose a PNG, JPEG, WebP or GIF image."),
                            };
                            let file =
                                fs::File::open(&path).map_err(|_| "Could not read image.")?;
                            if !file
                                .metadata()
                                .map_err(|_| "Could not read image.")?
                                .is_file()
                            {
                                return Err("Choose an image file.");
                            }
                            let mut bytes = Vec::new();
                            file.take(MAX_BYTES as u64 + 1)
                                .read_to_end(&mut bytes)
                                .map_err(|_| "Could not read image.")?;
                            (
                                path.file_name()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or("image")
                                    .to_owned(),
                                Image::from_bytes(format, bytes),
                            )
                        }
                    };
                    if image.bytes.is_empty() || image.bytes.len() > MAX_BYTES {
                        return Err("Image exceeds 5 MiB. Choose a smaller image.");
                    }
                    // Decode once on the executor, never while rendering a chip.
                    let preview = image
                        .to_image_data(renderer.clone())
                        .map_err(|_| "Could not decode image.")?;
                    let uri = format!(
                        "data:{};base64,{}",
                        image.format.mime_type(),
                        base64::engine::general_purpose::STANDARD.encode(&image.bytes)
                    );
                    Ok((json!({"name":name,"dataUri":uri}), uri, preview))
                })
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.controls.pending_images -= count;
                for result in result {
                    match result {
                        Ok((image, uri, preview)) => {
                            this.controls.images.push(image);
                            this.controls.previews.insert(uri, preview);
                        }
                        Err(error) => this.controls.error = error.into(),
                    }
                }
                this.images_changed(cx);
            });
        })
        .detach();
    }

    fn remove_image(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if index >= self.controls.images.len() {
            return;
        }
        self.controls.images.remove(index);
        self.controls.error.clear();
        // The following image now occupies this slot and inherits its Tab stop.
        let next = (index < self.controls.images.len())
            .then(|| {
                self.controls
                    .focus
                    .get(&format!("composer-image-remove-{index}"))
            })
            .flatten();
        next.unwrap_or(&self.focus).focus(window);
        self.images_changed(cx);
    }

    pub(crate) fn image_chips(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let count = self.controls.images.len();
        let file_count = self.controls.files.len();
        self.controls.focus.retain(|id, _| {
            for (prefix, count) in [
                ("composer-image-remove-", count),
                ("composer-file-remove-", file_count),
            ] {
                if let Some(index) = id
                    .strip_prefix(prefix)
                    .and_then(|index| index.parse::<usize>().ok())
                {
                    return index < count;
                }
            }
            true
        });
        let focuses: Vec<_> = (0..count)
            .map(|index| {
                self.controls
                    .focus
                    .entry(format!("composer-image-remove-{index}"))
                    .or_insert_with(|| cx.focus_handle().tab_stop(true))
                    .clone()
            })
            .collect();
        let file_focuses: Vec<_> = (0..file_count)
            .map(|index| {
                self.controls
                    .focus
                    .entry(format!("composer-file-remove-{index}"))
                    .or_insert_with(|| cx.focus_handle().tab_stop(true))
                    .clone()
            })
            .collect();
        // Also retire decoded buffers consumed by a confirmed send.
        self.controls.previews.retain(|uri, _| {
            self.controls
                .images
                .iter()
                .any(|image| image["dataUri"] == *uri)
        });
        div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .px(px(14.))
            .children(
                self.controls
                    .images
                    .iter()
                    .enumerate()
                    .map(|(index, image)| {
                        let preview: Option<Arc<RenderImage>> = self
                            .controls
                            .previews
                            .get(image["dataUri"].as_str().unwrap_or(""))
                            .cloned();
                        div()
                            .id(("composer-image", index))
                            .debug_selector(move || format!("composer-image-{index}"))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .p(px(4.))
                            .rounded(px(6.))
                            .bg(crate::theme::current().surface)
                            .when_some(preview, |d, preview| {
                                d.child(
                                    img(preview)
                                        .w(px(48.))
                                        .h(px(48.))
                                        .object_fit(ObjectFit::Contain),
                                )
                            })
                            .child(
                                div()
                                    .max_w(px(100.))
                                    .truncate()
                                    .text_size(px(11.))
                                    .child(image["name"].as_str().unwrap_or("Image").to_owned()),
                            )
                            .child(
                                div()
                                    .id(("composer-image-remove", index))
                                    .debug_selector(move || {
                                        format!("composer-image-remove-{index}")
                                    })
                                    .track_focus(&focuses[index])
                                    .tab_stop(true)
                                    .w(px(24.))
                                    .h(px(24.))
                                    .rounded(px(7.))
                                    .cursor_pointer()
                                    .focus(|s| s.bg(crate::theme::current().selection))
                                    .hover(|s| s.bg(crate::theme::current().hover))
                                    .child("×")
                                    .on_mouse_down(MouseButton::Left, {
                                        let focus = focuses[index].clone();
                                        cx.listener(move |_, _, window, _| focus.focus(window))
                                    })
                                    .on_click(cx.listener(
                                        move |this, event: &ClickEvent, window, cx| {
                                            // KeyDown owns keyboard activation. GPUI also
                                            // synthesizes a keyboard click on KeyUp.
                                            if matches!(event, ClickEvent::Mouse(_)) {
                                                this.remove_image(index, window, cx);
                                            }
                                        },
                                    ))
                                    .on_key_down(cx.listener(
                                        move |this, event: &KeyDownEvent, window, cx| {
                                            if matches!(
                                                event.keystroke.key.as_str(),
                                                "enter" | "space"
                                            ) {
                                                this.remove_image(index, window, cx);
                                                cx.stop_propagation();
                                            }
                                        },
                                    )),
                            )
                    }),
            )
            .children(self.controls.files.iter().enumerate().map(|(index, path)| {
                let video = VIDEO.contains(&extension(path).as_str());
                div()
                    .id(("composer-file", index))
                    .debug_selector(move || format!("composer-file-{index}"))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .h(px(32.))
                    .pl(px(8.))
                    .pr(px(4.))
                    .rounded(px(6.))
                    .bg(crate::theme::current().surface)
                    .child(crate::icon::stroke(
                        if video {
                            "M4 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z M17 10l5-3v10l-5-3"
                        } else {
                            "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6"
                        },
                        crate::theme::current().text_secondary,
                        15.,
                        1.6,
                    ))
                    .child(
                        div()
                            .max_w(px(160.))
                            .whitespace_normal()
                            .line_clamp(1)
                            .text_ellipsis()
                            .text_size(px(11.))
                            .child(
                                path.file_name()
                                    .map(|n| n.to_string_lossy().into_owned())
                                    .unwrap_or_default(),
                            ),
                    )
                    .child(
                        div()
                            .id(("composer-file-remove", index))
                            .debug_selector(move || format!("composer-file-remove-{index}"))
                            .track_focus(&file_focuses[index])
                            .tab_stop(true)
                            .w(px(24.))
                            .h(px(24.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(7.))
                            .cursor_pointer()
                            .focus(|s| s.bg(crate::theme::current().selection))
                            .hover(|s| s.bg(crate::theme::current().hover))
                            .child("×")
                            .on_mouse_down(MouseButton::Left, {
                                let focus = file_focuses[index].clone();
                                cx.listener(move |_, _, window, _| focus.focus(window))
                            })
                            .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                                if matches!(event, ClickEvent::Mouse(_)) {
                                    this.remove_file(index, window, cx);
                                }
                            }))
                            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                    this.remove_file(index, window, cx);
                                    cx.stop_propagation();
                                }
                            })),
                    )
            }))
            .into_any_element()
    }
}

fn extension(path: &std::path::Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// The line each attached file adds to the message, so the agent can open it.
pub(crate) fn file_lines(files: &[PathBuf]) -> String {
    files
        .iter()
        .map(|path| {
            let kind = if VIDEO.contains(&extension(path).as_str()) {
                "video"
            } else {
                "file"
            };
            format!("Attached {kind}: {}", path.display())
        })
        .collect::<Vec<_>>()
        .join("\n")
}
