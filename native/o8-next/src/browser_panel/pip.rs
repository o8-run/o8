//! BrowserPipCard's page selection is independent of the main active page.
use super::*;
impl BrowserPanel {
    pub(crate) fn preview_active(&self) -> Option<u64> {
        self.active
    }
    pub(crate) fn preview_pages(&self) -> Vec<(u64, String, String)> {
        let own = self.client.as_ref().and_then(|client| client.url("/").ok());
        let mut seen = std::collections::HashSet::new();
        self.tabs
            .iter()
            .filter_map(|tab| {
                let url = url::Url::parse(&tab.url).ok()?;
                if url.host_str().is_none()
                    || own.as_ref().is_some_and(|own| {
                        own.host_str() == url.host_str() && own.port() == url.port()
                    })
                    || !seen.insert(tab.url.clone())
                {
                    return None;
                }
                Some((tab.id, tab.title.clone(), tab.url.clone()))
            })
            .collect()
    }
    pub(crate) fn preview(&mut self, page: Option<u64>, viewport: f32, cx: &mut Context<Self>) {
        if self.preview != page || self.preview_viewport != viewport {
            self.hide_pages();
            self.preview = page;
            self.preview_viewport = viewport;
            cx.notify();
        }
    }
    pub(crate) fn remote_owner(&mut self, active: bool, cx: &mut Context<Self>) {
        if !active && self.remote.take().is_some() {
            cx.notify();
        }
    }
}

/// Direct geometry port of classic pip-layout.ts, including composer avoidance.
pub(crate) fn fit(
    bounds: [f32; 4],
    preferred: [f32; 2],
    position: Option<[f32; 2]>,
    composer: Option<[f32; 4]>,
) -> ([f32; 2], [f32; 2]) {
    let [left, top, w, h] = bounds;
    let ratio = 1f32
        .min((w - 16.).max(1.) / preferred[0])
        .min((h - 46.).max(1.) / preferred[1]);
    let (mut width, mut height) = (preferred[0] * ratio, preferred[1] * ratio);
    let mut x = position
        .map_or(left + w - width - 8., |p| p[0])
        .max(left + 8.)
        .min((left + w - width - 8.).max(left + 8.));
    let floor = composer
        .filter(|c| x < c[0] + c[2] && x + width > c[0])
        .map_or(top + h, |c| (top + h).min(c[1].max(top)));
    let available = (floor - top - 46.).max(1.);
    if height > available {
        width *= available / height;
        height = available;
    }
    x = position
        .map_or(left + w - width - 8., |p| p[0])
        .max(left + 8.)
        .min((left + w - width - 8.).max(left + 8.));
    let y = position
        .map_or(floor - height - 38., |p| p[1])
        .max(top + 8.)
        .min((floor - height - 38.).max(top + 8.));
    ([x, y], [width, height])
}
