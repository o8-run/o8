//! Classic's complete @pierre/trees file icon set and filename overrides.
//! Apache-2.0; see tree-icons-LICENSE.md and tree-icons-NOTICE.md.
use super::*;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
};
static DATA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("tree-icons.json")).expect("bundled tree icons")
});
enum State {
    Loading(Vec<gpui::WeakEntity<FilesPanel>>),
    Ready(Arc<gpui::RenderImage>),
    Failed,
}
#[derive(Default)]
struct Cache(HashMap<String, State>);
impl gpui::Global for Cache {}
fn token(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    if let Some(token) = DATA["names"][&name].as_str() {
        return token.into();
    }
    for (at, _) in name.match_indices('.') {
        let ext = &name[at + 1..];
        if let Some(token) = DATA["overrides"][ext]
            .as_str()
            .or_else(|| DATA["extensions"][ext].as_str())
        {
            return token.into();
        }
    }
    "default".into()
}
pub(super) fn view(path: &str, size: f32, cx: &mut Context<FilesPanel>) -> gpui::AnyElement {
    let token = token(path);
    let color = match DATA["colors"][&token].as_str().unwrap_or("gray") {
        "red" | "vermilion" => gpui::rgb(theme().terminal_ansi[1]),
        "green" => gpui::rgb(theme().terminal_ansi[2]),
        "orange" | "yellow" => gpui::rgb(theme().terminal_ansi[3]),
        "blue" | "indigo" => gpui::rgb(theme().terminal_ansi[4]),
        "pink" | "purple" | "mauve" => gpui::rgb(theme().terminal_ansi[5]),
        "cyan" | "teal" => gpui::rgb(theme().terminal_ansi[6]),
        _ => theme().text_muted,
    };
    if cx.try_global::<Cache>().is_none() {
        cx.set_global(Cache::default());
    }
    if !cx.global::<Cache>().0.contains_key(&token) {
        let watcher = cx.entity().downgrade();
        cx.global_mut::<Cache>()
            .0
            .insert(token.clone(), State::Loading(vec![watcher]));
        let symbol = DATA["symbols"][&token]
            .as_str()
            .or_else(|| DATA["symbols"]["default"].as_str())
            .unwrap_or("");
        let color = format!(
            "#{:02x}{:02x}{:02x}",
            (color.r * 255.).round() as u8,
            (color.g * 255.).round() as u8,
            (color.b * 255.).round() as u8
        );
        let symbol = symbol
            .replace("currentColor", &color)
            .replace("currentcolor", &color);
        let viewbox = if token == "agents" { 24 } else { 16 };
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 {viewbox} {viewbox}">{symbol}</svg>"#
        );
        let path = super::media::svg_path();
        let loader = <gpui::ImageAssetLoader as gpui::Asset>::load(
            gpui::Resource::Path(path.clone().into()),
            cx,
        );
        let work = cx
            .background_executor()
            .spawn(async move { super::media::decode_svg(path, &svg, loader).await });
        let key = token.clone();
        cx.spawn(async move |_, cx| {
            let result = work.await;
            let _ = cx.update_global::<Cache, _>(|cache, cx| {
                let watchers = match cache.0.remove(&key) {
                    Some(State::Loading(w)) => w,
                    _ => vec![],
                };
                cache.0.insert(
                    key,
                    match result {
                        Ok(image) => State::Ready(image),
                        Err(_) => State::Failed,
                    },
                );
                for watcher in watchers {
                    let _ = watcher.update(cx, |_, cx| cx.notify());
                }
            });
        })
        .detach();
    } else {
        let watcher = cx.entity().downgrade();
        if let Some(State::Loading(watchers)) = cx.global_mut::<Cache>().0.get_mut(&token)
            && !watchers
                .iter()
                .any(|w| w.entity_id() == watcher.entity_id())
        {
            watchers.push(watcher);
        }
    }
    let image = match cx.global::<Cache>().0.get(&token) {
        Some(State::Ready(image)) => Some(image.clone()),
        _ => None,
    };
    #[cfg(test)]
    {
        if cx.try_global::<super::tests::tree_tests::Icons>().is_none() {
            cx.set_global(super::tests::tree_tests::Icons::default());
        }
        cx.global_mut::<super::tests::tree_tests::Icons>()
            .0
            .insert(path.into(), token);
    }
    match image {
        Some(image) => gpui::img(image)
            .size(px(size))
            .flex_shrink_0()
            .into_any_element(),
        None => crate::icon::stroke(FILE, theme().text_muted, size, 1.6).into_any_element(),
    }
}
