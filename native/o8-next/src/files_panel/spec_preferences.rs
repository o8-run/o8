//! Classic's six recent targets, shared override and user-selected note ink.
use super::*;
use serde::{Deserialize, Serialize};
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub target_override: Option<String>,
    pub recents: Vec<String>,
    pub color: Option<String>,
}
impl Preferences {
    pub fn clean(mut self) -> Self {
        self.target_override = self.target_override.and_then(|p| normalize(&p));
        let mut recents = vec![];
        for p in self.recents {
            if let Some(p) = normalize(&p)
                && !recents.contains(&p)
                && recents.len() < 6
            {
                recents.push(p);
            }
        }
        self.recents = recents;
        if self.color.as_deref().and_then(parse_color).is_none() {
            self.color = None;
        }
        self
    }
    pub(super) fn ink(&self) -> Rgba {
        self.color
            .as_deref()
            .and_then(parse_color)
            .unwrap_or_else(crate::theme::brand_orange)
    }
    pub(super) fn remember(&mut self, path: String) {
        self.recents.retain(|p| p != &path);
        self.recents.insert(0, path);
        self.recents.truncate(6);
    }
}
pub(super) fn normalize(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 32768 {
        return None;
    }
    let mut path = raw.trim_end_matches(['/', '\\']).to_owned();
    if path.is_empty() && raw.starts_with('/') {
        path = "/".into();
    }
    if path
        .rsplit(['/', '\\'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("o8.md"))
    {
        let at = path.rfind(['/', '\\'])?;
        path = path[..at].to_owned();
        if path.is_empty() {
            path = "/".into();
        } else if path.ends_with(':') {
            path.push('/');
        }
    }
    let absolute = path.starts_with('/')
        || (path.len() > 2
            && path.as_bytes()[1] == b':'
            && matches!(path.as_bytes()[2], b'/' | b'\\'));
    absolute.then_some(path)
}
fn parse_color(color: &str) -> Option<Rgba> {
    if let Some(hex) = color.strip_prefix('#')
        && hex.len() == 6
    {
        return u32::from_str_radix(hex, 16).ok().map(gpui::rgb);
    }
    let hue = color
        .strip_prefix("hsl(")?
        .strip_suffix(')')?
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    if hue.len() != 3 || hue[1] != "80%" || hue[2] != "55%" {
        return None;
    }
    let h = hue[0].parse::<u16>().ok()?;
    if h > 360 {
        return None;
    }
    Some(gpui::hsla(h as f32 / 360., 0.8, 0.55, 1.).into())
}
#[derive(Clone)]
pub struct Changed(pub Preferences);
