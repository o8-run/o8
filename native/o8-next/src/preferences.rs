use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Preferences {
    pub version: u8,
    pub palette: String,
    pub glass: bool,
    pub all_glass: bool,
    pub sidebar_width: f32,
    pub sidebar_visible: bool,
    pub window_size: Option<[f32; 2]>,
}
impl Preferences {
    pub(super) fn parse(value: &str) -> Option<Self> {
        if value.len() > 4096 {
            return None;
        }
        let prefs: Self = serde_json::from_str(value).ok()?;
        if prefs.version != 1
            || prefs.all_glass && !prefs.glass
            || !["light", "dark"].contains(&prefs.palette.as_str())
            || !prefs.sidebar_width.is_finite()
            || !(160. ..=500.).contains(&prefs.sidebar_width)
            || prefs.window_size.is_some_and(|[w, h]| {
                !w.is_finite()
                    || !h.is_finite()
                    || !(600. ..=7680.).contains(&w)
                    || !(400. ..=4320.).contains(&h)
            })
        {
            return None;
        }
        Some(prefs)
    }
}

#[cfg(test)]
#[path = "preferences_tests.rs"]
mod tests;
