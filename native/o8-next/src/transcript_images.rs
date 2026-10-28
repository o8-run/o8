//! Transcript bytes only cross the existing media route's canonical path checks.
use super::{BTreeSet, Client, HashMap, Rc, RefCell, Row, Surface, theme};
use gpui::{prelude::*, *};
use std::{io::Read, sync::Arc};

#[derive(Clone)]
pub(crate) enum ImageState {
    Loading,
    Ready(Arc<RenderImage>),
    Unavailable,
}
pub(crate) type Cache = Rc<RefCell<HashMap<String, ImageState>>>;

pub(crate) fn paths(row: &Row) -> Vec<String> {
    let Row::Message { nodes, .. } = row else {
        return vec![];
    };
    nodes
        .iter()
        .filter_map(|node| {
            let data = node.data.as_ref()?;
            (node.kind == "media" && data["kind"] == "image")
                .then(|| data["path"].as_str().unwrap_or("").to_owned())
        })
        .collect()
}
fn read(client: &Client, path: &str) -> Result<Image, ()> {
    let mut url = client.url("/api/mobile/media").map_err(|_| ())?;
    url.query_pairs_mut().append_pair("path", path);
    let response = client.request("GET", &url).call().map_err(|_| ())?;
    let format = match response
        .header("Content-Type")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::Webp,
        _ => return Err(()),
    };
    const MAX_BYTES: u64 = 32 * 1024 * 1024;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(());
    }
    Ok(Image::from_bytes(format, bytes))
}
impl Surface {
    pub(super) fn load_images(&mut self, cx: &mut Context<Self>) {
        let mut pending = Vec::new();
        {
            let mut cache = self.images.borrow_mut();
            for row in self.rows.iter() {
                for path in paths(&row.borrow().row) {
                    if let std::collections::hash_map::Entry::Vacant(entry) =
                        cache.entry(path.clone())
                    {
                        entry.insert(ImageState::Loading);
                        pending.push(path);
                    }
                }
            }
        }
        if pending.is_empty() {
            return;
        }
        let client = self.client.clone();
        let renderer = cx.svg_renderer();
        let task = cx.background_executor().spawn(async move {
            pending
                .into_iter()
                .map(|path| {
                    let state = match read(&client, &path)
                        .and_then(|image| image.to_image_data(renderer.clone()).map_err(|_| ()))
                    {
                        Ok(image) => ImageState::Ready(image),
                        Err(()) => ImageState::Unavailable,
                    };
                    (path, state)
                })
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let loaded = task.await;
            let _ = this.update(cx, |s, cx| {
                let changed: BTreeSet<_> = loaded.iter().map(|(path, _)| path.clone()).collect();
                s.images.borrow_mut().extend(loaded);
                let mut visible = false;
                for (index, row) in s.rows.iter().enumerate() {
                    if paths(&row.borrow().row)
                        .iter()
                        .any(|path| changed.contains(path))
                    {
                        row.borrow_mut().invalidate_image_layout();
                        s.list.splice(index..index + 1, 1);
                        visible = true;
                    }
                }
                if visible {
                    cx.notify();
                }
            });
        })
        .detach();
    }
}

struct Viewer {
    image: Arc<RenderImage>,
    name: String,
    focus: FocusHandle,
}
impl Render for Viewer {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme().background)
            .text_color(theme().text)
            .track_focus(&self.focus)
            .on_key_down(|event, window, cx| {
                if event.keystroke.key == "escape" {
                    window.remove_window();
                    cx.stop_propagation();
                }
            })
            .child(
                div()
                    .px(px(16.))
                    .py(px(10.))
                    .text_size(px(12.))
                    .child(format!("{}  ·  Esc to close", self.name)),
            )
            .child(
                div().flex_1().min_h_0().w_full().child(
                    img(self.image.clone())
                        .size_full()
                        .object_fit(ObjectFit::Contain),
                ),
            )
    }
}
pub(crate) fn open(image: Arc<RenderImage>, name: String, cx: &mut App) {
    let _ = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                point(px(120.), px(100.)),
                size(px(1000.), px(760.)),
            ))),
            focus: true,
            ..Default::default()
        },
        |window, cx| {
            cx.new(|cx| {
                let focus = cx.focus_handle();
                focus.focus(window);
                Viewer { image, name, focus }
            })
        },
    );
}
