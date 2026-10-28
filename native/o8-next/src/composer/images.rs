//! Manual paste, file picker and OS drop share the desktop's four-image/5 MiB limits.
use super::Composer;
use base64::Engine;
use gpui::{prelude::*, *};
use serde_json::json;
use std::{fs, io::Read, path::PathBuf, sync::Arc};

const MAX_IMAGES: usize = 4;
const MAX_BYTES: usize = 5 * 1024 * 1024;
pub(crate) struct ImagesChanged;
impl EventEmitter<ImagesChanged> for Composer {}
enum Input {
    Clipboard(Image),
    Path(PathBuf),
}

impl Composer {
    pub(crate) fn attach_clipboard(&mut self, item: &ClipboardItem, cx: &mut Context<Self>) {
        self.attach_images(
            item.entries()
                .iter()
                .filter_map(|entry| match entry {
                    ClipboardEntry::Image(image) => Some(Input::Clipboard(image.clone())),
                    _ => None,
                })
                .collect(),
            cx,
        );
    }
    pub(crate) fn attach_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        self.attach_images(paths.into_iter().map(Input::Path).collect(), cx);
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
        self.controls.error.clear();
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

    pub(crate) fn image_chips(&mut self, cx: &mut Context<Self>) -> AnyElement {
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
                                    .w(px(24.))
                                    .h(px(24.))
                                    .cursor_pointer()
                                    .child("×")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if index < this.controls.images.len() {
                                            this.controls.images.remove(index);
                                            this.controls.error.clear();
                                            this.images_changed(cx);
                                        }
                                    })),
                            )
                    }),
            )
            .into_any_element()
    }
}
