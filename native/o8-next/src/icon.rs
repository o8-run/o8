//! Stroked line icons on a 24-unit grid, tinted like text,
//! and the small tooltip the desktop shows on icon-only controls.
use crate::theme::current as theme;
use gpui::{
    AssetSource, Context, IntoElement, ParentElement, Render, Rgba, SharedString, Styled, Svg,
    Window, div, px, svg,
};
use std::borrow::Cow;

const PREFIX: &str = "o8-stroke/";
const FILL: &str = "o8-fill/";

/// GPUI's `svg()` element: a mask tinted by the text colour and rasterised at the
/// display scale. The asset path carries the stroke weight and path data.
pub fn stroke(path: &str, color: Rgba, size: f32, weight: f32) -> Svg {
    svg()
        .path(format!("{PREFIX}{weight}/{path}"))
        .size(px(size))
        .flex_shrink_0()
        .text_color(color)
}

/// A filled glyph on the same grid, such as a disclosure triangle.
pub fn fill(path: &str, color: Rgba, size: f32) -> Svg {
    svg()
        .path(format!("{FILL}{path}"))
        .size(px(size))
        .flex_shrink_0()
        .text_color(color)
}

/// Serves the stroked and filled icons above; nothing else is read from disk.
pub struct Assets;
impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        if let Some(d) = path.strip_prefix(FILL) {
            return Ok(Some(Cow::Owned(
                format!(
                    r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#000"><path d="{d}"/></svg>"##
                )
                .into_bytes(),
            )));
        }
        Ok(path
            .strip_prefix(PREFIX)
            .and_then(|rest| rest.split_once('/'))
            .map(|(weight, d)| {
                Cow::Owned(format!(
                    r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="{weight}" stroke-linecap="round" stroke-linejoin="round"><path d="{d}"/></svg>"##
                ).into_bytes())
            }))
    }
    fn list(&self, _: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(vec![])
    }
}

pub struct Tip(pub SharedString);
impl Render for Tip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(8.))
            .py(px(4.))
            .rounded(px(6.))
            .bg(crate::theme::menu_fill())
            .border_1()
            .border_color(theme().border)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .text_size(px(12.))
            .child(self.0.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stroke_assets_carry_weight_and_path() {
        let svg = Assets
            .load("o8-stroke/1.6/M12 5v14M5 12h14")
            .unwrap()
            .unwrap();
        let svg = std::str::from_utf8(&svg).unwrap();
        assert!(svg.contains(r#"stroke-width="1.6""#), "{svg}");
        assert!(svg.contains(r#"d="M12 5v14M5 12h14""#), "{svg}");
        let fill = Assets.load("o8-fill/M5 2L19 12L5 22Z").unwrap().unwrap();
        let fill = std::str::from_utf8(&fill).unwrap();
        assert!(fill.contains(r##"fill="#000""##) && fill.contains(r#"d="M5 2L19 12L5 22Z""#));
        assert!(Assets.load("icons/other.svg").unwrap().is_none());
    }
}
