//! Scoped image paste/drop, existing repo-spec asset writer and inline previews.
use super::super::{io, media};
use super::*;
use crate::client::Client;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
pub(super) enum Input {
    Image(Image),
    Path(PathBuf),
}
#[derive(Default)]
pub(in crate::files_panel) struct Assets {
    pub target: Option<(Client, String)>,
    pub generation: u64,
    pub previews: HashMap<String, Option<media::Preview>>,
    pub positions: Vec<(String, Pixels, Pixels)>,
    pub error: Option<String>,
    pub pending: usize,
}
pub(super) fn references(text: &str) -> Vec<(usize, String)> {
    static IMAGES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"(?m)^!\[[^\]\n]*\]\((o8-assets/[^\s\)]+)(?:\s+"[^"]*")?\)\s*$"#)
            .unwrap()
    });
    IMAGES
        .captures_iter(text)
        .map(|m| (m.get(0).unwrap().start(), m[1].into()))
        .collect()
}
impl Editor {
    pub(super) fn paste_images(
        &mut self,
        item: &ClipboardItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let images = item
            .entries()
            .iter()
            .filter_map(|e| {
                if let ClipboardEntry::Image(image) = e {
                    Some(Input::Image(image.clone()))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        if images.is_empty() {
            return false;
        }
        for input in images {
            self.upload_image(input, window, cx);
        }
        true
    }
    pub(super) fn upload_image(
        &mut self,
        input: Input,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((client, repo)) = self.assets.target.clone() else {
            return;
        };
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let placeholder = format!(
            "![Uploading image…](o8-upload-{}-{})",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let cursor = self.cursor();
        let lead = if cursor > 0 && !self.text[..cursor].ends_with('\n') {
            "\n"
        } else {
            ""
        };
        let trail = if self.text[cursor..].starts_with('\n') {
            ""
        } else {
            "\n"
        };
        self.replace_text_in_range(None, &format!("{lead}{placeholder}{trail}"), window, cx);
        self.assets.pending += 1;
        self.assets.error = None;
        let generation = self.assets.generation;
        let renderer = cx.svg_renderer();
        let work = cx.background_executor().spawn(async move {
            let dimensions = image_dimensions(&input, |image| {
                image.to_image_data(renderer).ok().map(|p| p.size(0))
            });
            upload(&client, &repo, input).map(|path| (path, dimensions))
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.assets.generation {
                    return;
                }
                this.assets.pending = this.assets.pending.saturating_sub(1);
                let replacement = match result {
                    Ok((path, dimensions)) => match dimensions {
                        Some((w, h)) => format!("![image]({path} \"{w}x{h}\")"),
                        None => format!("![image]({path})"),
                    },
                    Err(error) => {
                        this.assets.error = Some(error);
                        String::new()
                    }
                };
                if let Some(at) = this.text.find(&placeholder) {
                    let mut end = at + placeholder.len();
                    if replacement.is_empty() && this.text[end..].starts_with('\n') {
                        end += 1;
                    }
                    this.undo.push(this.snapshot());
                    this.redo.clear();
                    let selection = this.selection.clone();
                    let anchor = this.anchor;
                    let marked = this.marked.clone();
                    let translate = |p: usize| {
                        if p <= at {
                            p
                        } else if p >= end {
                            at + replacement.len() + p - end
                        } else {
                            at + replacement.len()
                        }
                    };
                    this.replace(at..end, &replacement);
                    this.selection = translate(selection.start)..translate(selection.end);
                    this.anchor = translate(anchor);
                    this.marked = marked.map(|r| translate(r.start)..translate(r.end));
                    this.changed(cx);
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn load_images(&mut self, cx: &mut Context<Self>) {
        let Some((client, repo)) = self.assets.target.clone() else {
            return;
        };
        for (_, path) in references(&self.text) {
            if self.assets.previews.contains_key(&path) {
                continue;
            }
            self.assets.previews.insert(path.clone(), None);
            let client = client.clone();
            let repo = repo.clone();
            let requested = path.clone();
            let renderer = cx.svg_renderer();
            let generation = self.assets.generation;
            let svg = media::is_svg(&requested).then(|| {
                let path = media::svg_path();
                let decoder = <gpui::ImageAssetLoader as gpui::Asset>::load(
                    gpui::Resource::Path(path.clone().into()),
                    cx,
                );
                (path, decoder)
            });
            let work = cx.background_executor().spawn(async move {
                if let Some((path, decoder)) = svg {
                    let image = media::read_image(&client, &repo, &requested)?;
                    let source =
                        std::str::from_utf8(&image.bytes).map_err(|_| "Invalid SVG image.")?;
                    media::decode_svg(path, source, decoder).await
                } else {
                    media::read(&client, &repo, &requested, |image| {
                        image
                            .to_image_data(renderer)
                            .map_err(|_| "Unable to preview this image.".into())
                    })
                }
            });
            cx.spawn(async move |this, cx| {
                let result = work.await;
                let _ = this.update(cx, |this, cx| {
                    if this.assets.generation == generation {
                        this.assets.previews.insert(path, Some(result));
                        cx.notify();
                    }
                });
            })
            .detach();
        }
    }
    pub(super) fn inline_images(&self) -> AnyElement {
        div()
            .absolute()
            .left(px(4.))
            .right(px(158.))
            .top(px(22.))
            .children(self.assets.positions.iter().map(|(path, top, height)| {
                div()
                    .debug_selector(|| "spec-inline-image".into())
                    .absolute()
                    .top(*top)
                    .w_full()
                    .h(*height)
                    .overflow_hidden()
                    .rounded(px(10.))
                    .border_1()
                    .border_color(theme().border)
                    .child(
                        match self.assets.previews.get(path).and_then(Option::as_ref) {
                            Some(Ok(image)) => div()
                                .debug_selector({
                                    let svg = media::is_svg(path);
                                    move || {
                                        if svg {
                                            "spec-inline-svg-loaded".into()
                                        } else {
                                            "spec-inline-image-loaded".into()
                                        }
                                    }
                                })
                                .size_full()
                                .child(
                                    gpui::img(image.clone())
                                        .size_full()
                                        .object_fit(ObjectFit::Contain),
                                )
                                .into_any_element(),
                            Some(Err(error)) => div()
                                .text_size(px(10.5))
                                .p(px(8.))
                                .text_color(theme().danger)
                                .child(error.clone())
                                .into_any_element(),
                            None => div()
                                .p(px(8.))
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child("Loading image…")
                                .into_any_element(),
                        },
                    )
            }))
            .into_any_element()
    }
}
fn upload(client: &Client, repo: &str, input: Input) -> Result<String, String> {
    let (status, body) = match input {
        Input::Path(path) => {
            if !media::is_image(path.to_str().unwrap_or(""))
                && !media::is_svg(path.to_str().unwrap_or(""))
            {
                return Err("Choose an image file.".into());
            }
            let path = path.to_str().ok_or("Invalid image path")?;
            io::json_request(
                client,
                "POST",
                "/api/repo-spec/asset",
                &[("repoPath", repo), ("srcPath", path)],
                Some(serde_json::json!({})),
            )?
        }
        Input::Image(image) => {
            let mime = match image.format {
                ImageFormat::Png => "image/png",
                ImageFormat::Jpeg => "image/jpeg",
                ImageFormat::Webp => "image/webp",
                ImageFormat::Gif => "image/gif",
                _ => return Err("Paste a PNG, JPEG, WebP or GIF image.".into()),
            };
            if image.bytes.len() > 10 * 1024 * 1024 {
                return Err("Image exceeds 10 MB.".into());
            }
            let mut url = client
                .url("/api/repo-spec/asset")
                .map_err(|_| "Unable to upload image")?;
            url.query_pairs_mut().append_pair("repoPath", repo);
            let response = match client
                .request("POST", &url)
                .timeout(std::time::Duration::from_secs(30))
                .set("Content-Type", mime)
                .set("x-filename", "clipboard.png")
                .send_bytes(&image.bytes)
            {
                Ok(r) => r,
                Err(ureq::Error::Status(_, r)) => r,
                Err(_) => return Err("Image upload failed.".into()),
            };
            (
                response.status(),
                response
                    .into_json::<serde_json::Value>()
                    .map_err(|_| "Invalid image upload response")?,
            )
        }
    };
    if status >= 300 || body["ok"] != true {
        return Err(body["error"]
            .as_str()
            .unwrap_or("Image upload failed.")
            .into());
    }
    body["relPath"]
        .as_str()
        .filter(|p| {
            p.starts_with("o8-assets/") && !p.contains("..") && !p.chars().any(char::is_whitespace)
        })
        .map(str::to_owned)
        .ok_or("Invalid uploaded image reference".into())
}

fn image_dimensions(
    input: &Input,
    dimensions: impl FnOnce(Image) -> Option<Size<DevicePixels>>,
) -> Option<(i32, i32)> {
    use std::io::Read;
    let image = match input {
        Input::Image(image) => image.clone(),
        Input::Path(path) => {
            let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                "gif" => "image/gif",
                "avif" => "image/avif",
                "svg" => "image/svg+xml",
                _ => return None,
            };
            let file = std::fs::File::open(path).ok()?;
            if file.metadata().ok()?.len() > 10 * 1024 * 1024 {
                return None;
            }
            let mut bytes = vec![];
            file.take(10 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            if bytes.len() > 10 * 1024 * 1024 {
                return None;
            }
            Image::from_bytes(ImageFormat::from_mime_type(mime)?, bytes)
        }
    };
    let size = dimensions(image)?;
    (size.width.0 > 0 && size.height.0 > 0).then_some((size.width.0, size.height.0))
}
pub(super) fn ratio(line: &str) -> Option<f32> {
    static DIMENSIONS: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r#"\s+"(\d+)x(\d+)"\)"#).unwrap());
    let captures = DIMENSIONS.captures(line)?;
    let w = captures[1].parse::<f32>().ok()?;
    let h = captures[2].parse::<f32>().ok()?;
    (w > 0. && h > 0.).then_some(w / h)
}
