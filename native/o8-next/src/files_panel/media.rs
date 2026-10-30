//! MediaPreview's contained image card. Bytes use the same checked asset route
//! as classic, with operator authentication and background decoding.
use super::*;
use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, GlobalElementId, Image, ImageFormat,
    InspectorElementId, LayoutId, ObjectFit, Pixels, RenderImage, Style, StyledImage, canvas, img,
    point, size,
};
use std::{
    io::{Read, Write},
    sync::Arc,
};

pub(super) type Preview = Result<Arc<RenderImage>, String>;
fn extension(path: &str) -> String {
    path.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
}
pub(super) fn is_svg(path: &str) -> bool {
    extension(path) == "svg"
}
pub(super) fn is_image(path: &str) -> bool {
    matches!(
        extension(path).as_str(),
        "avif" | "bmp" | "gif" | "ico" | "jpg" | "jpeg" | "png" | "webp"
    )
}
pub(super) fn unsupported(path: &str) -> Option<&'static str> {
    match extension(path).as_str() {
        "pdf" => Some("PDF"),
        "mp4" | "m4v" | "mov" | "webm" => Some("Video"),
        "mp3" | "wav" | "m4a" | "aac" | "ogg" | "flac" => Some("Audio"),
        _ => None,
    }
}
fn read(
    client: &Client,
    workspace: &str,
    path: &str,
    decode: impl FnOnce(Image) -> Preview,
) -> Preview {
    let mut url = client
        .url("/api/panel/file-asset")
        .map_err(|_| "Unable to preview this file.")?;
    url.query_pairs_mut()
        .append_pair("path", path)
        .append_pair("workspace", workspace);
    let response = client
        .request("GET", &url)
        .call()
        .map_err(|_| "Unable to preview this file.")?;
    let format = response
        .header("Content-Type")
        .and_then(|value| ImageFormat::from_mime_type(value.split(';').next().unwrap_or("").trim()))
        .ok_or("Preview unavailable for this image type.")?;
    const LIMIT: u64 = 50 * 1024 * 1024;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to preview this file.")?;
    if bytes.len() as u64 > LIMIT {
        return Err("Image exceeds the preview size limit.".into());
    }
    decode(Image::from_bytes(format, bytes))
}
impl FilesPanel {
    pub(super) fn open_image(&mut self, path: String, cx: &mut Context<Self>) {
        self.file_generation += 1;
        let generation = self.file_generation;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let renderer = cx.svg_renderer();
        let task = cx.background_executor().spawn(async move {
            read(&client, &workspace, &path, |image| {
                image
                    .to_image_data(renderer)
                    .map_err(|_| "Unable to preview this file.".into())
            })
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.file_generation {
                    return;
                }
                this.file = match result {
                    Ok(image) => File::Image(image),
                    Err(error) => File::Failed(error),
                };
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
// GPUI's normal asset loader handles SVG premultiplication and BGRA correctly;
// its clipboard Image decoder does not. Feed only the server-inspected bytes to
// that loader through a private temporary file, removed on success or failure.
pub(super) fn svg_path() -> std::path::PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("o8-next-svg-{}-{id}.svg", std::process::id()))
}
struct SvgInput(std::path::PathBuf);
impl Drop for SvgInput {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
pub(super) async fn decode_svg<E>(
    path: std::path::PathBuf,
    source: &str,
    decoder: impl std::future::Future<Output = Result<Arc<RenderImage>, E>>,
) -> Preview {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "Unable to prepare SVG preview.")?;
    let _input = SvgInput(path);
    file.write_all(source.as_bytes())
        .map_err(|_| "Unable to prepare SVG preview.")?;
    drop(file);
    decoder
        .await
        .map_err(|_| "Unable to preview this file.".into())
}

pub(super) fn view(image: Arc<RenderImage>, generation: u64, svg: bool) -> gpui::AnyElement {
    div()
        .id("files-media")
        .debug_selector(move || format!("files-media-{generation}"))
        .flex_1()
        .min_w_0()
        .min_h_0()
        .p(px(24.))
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        // The pinned GPUI asset loader rasterizes SVGs at 2x and records that
        // scale for img(). Keep the card at the SVG's natural logical size.
        .child(Card(image, if svg { 2. } else { 1. }))
        .into_any_element()
}

// Measure against both available dimensions so a large portrait or landscape
// retains its aspect ratio when the panel is resized, including narrow panes.
struct Card(Arc<RenderImage>, f32);
impl IntoElement for Card {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for Card {
    type RequestLayoutState = ();
    type PrepaintState = gpui::AnyElement;
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        _: &mut App,
    ) -> (LayoutId, ()) {
        let natural = self.0.size(0);
        let w = natural.width.0 as f32 / self.1;
        let h = natural.height.0 as f32 / self.1;
        let id = window.request_measured_layout(Style::default(), move |known, available, _, _| {
            let bound = |known: Option<Pixels>, available, fallback| {
                f32::from(known.unwrap_or(match available {
                    AvailableSpace::Definite(value) => value,
                    _ => px(fallback),
                }))
            };
            let max_w = (bound(known.width, available.width, w + 38.) - 38.)
                .max(1.)
                .min(900.);
            let max_h = (bound(known.height, available.height, h + 38.) - 38.).max(1.);
            let scale = (max_w / w).min(max_h / h).min(1.);
            size(px(w * scale + 38.), px(h * scale + 38.))
        });
        (id, ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> gpui::AnyElement {
        let mut card = div()
            .debug_selector(|| "files-image-card".into())
            .size_full()
            .min_w_0()
            .min_h_0()
            .relative()
            .p(px(18.))
            .border_1()
            .border_color(theme().border)
            .rounded(px(12.))
            .bg(theme().surface_raised)
            .shadow_sm()
            .overflow_hidden()
            .child(
                canvas(
                    |_, _, _| (),
                    |bounds, _, window, _| {
                        let columns = (f32::from(bounds.size.width) / 10.).ceil() as usize;
                        let rows = (f32::from(bounds.size.height) / 10.).ceil() as usize;
                        for y in 0..rows {
                            for x in 0..columns {
                                if (x + y) % 2 == 0 {
                                    let origin = bounds.origin
                                        + point(px(x as f32 * 10.), px(y as f32 * 10.));
                                    let tile = Bounds::new(
                                        origin,
                                        size(
                                            px(10.).min(bounds.right() - origin.x),
                                            px(10.).min(bounds.bottom() - origin.y),
                                        ),
                                    );
                                    window.paint_quad(gpui::fill(
                                        tile,
                                        gpui::Hsla::from(theme().border).opacity(0.35),
                                    ));
                                }
                            }
                        }
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .child(
                img(self.0.clone())
                    .size_full()
                    .object_fit(ObjectFit::Contain),
            )
            .into_any_element();
        card.layout_as_root(bounds.size.map(AvailableSpace::Definite), window, cx);
        card.prepaint_at(bounds.origin, window, cx);
        card
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        card: &mut gpui::AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        card.paint(window, cx);
    }
}
