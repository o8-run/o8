//! Read-only workspace browsing. Source never becomes a GPUI input entity.
use super::{requests, source::Source};
use crate::{
    client::Client,
    composer::{Composer, Submit},
    theme::current as theme,
};
use gpui::{prelude::*, *};
use std::rc::Rc;

pub(crate) struct Files {
    client: Client,
    workspace: String,
    path_input: Entity<Composer>,
    focus: FocusHandle,
    path: String,
    directory: String,
    entries: Vec<requests::Entry>,
    source: Rc<Source>,
    loading: bool,
    browsing: bool,
    ready: bool,
    notice: String,
    browse_notice: String,
    generation: u64,
    browse_generation: u64,
    scroll: UniformListScrollHandle,
    _subscription: Subscription,
}
impl Files {
    pub(crate) fn new(
        client: Client,
        workspace: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let path_input = cx.new(Composer::new);
        path_input.read(cx).focus.focus(window);
        let subscription = cx.subscribe(&path_input, |this, _, _: &Submit, cx| this.open(cx));
        let mut view = Self {
            client,
            workspace,
            path_input,
            focus: cx.focus_handle(),
            path: String::new(),
            directory: String::new(),
            entries: vec![],
            source: Rc::new(Source::default()),
            loading: false,
            browsing: false,
            ready: false,
            notice: String::new(),
            browse_notice: String::new(),
            generation: 0,
            browse_generation: 0,
            scroll: UniformListScrollHandle::new(),
            _subscription: subscription,
        };
        view.browse(String::new(), cx);
        view
    }
    pub(crate) fn focus(&self, window: &mut Window, cx: &App) {
        if self.ready && !self.source.binary && !self.source.masked {
            self.focus.focus(window);
        } else {
            self.path_input.read(cx).focus.focus(window);
        }
    }
    fn open(&mut self, cx: &mut Context<Self>) {
        let path = self.path_input.read(cx).text.trim().to_owned();
        if path.is_empty() || self.loading {
            return;
        }
        if super::guard::sensitive(&path) {
            self.path_input.update(cx, |input, cx| input.clear(cx));
            self.notice = "Sensitive path masked".into();
            cx.notify();
            return;
        }
        self.read(path, cx);
    }
    fn read(&mut self, path: String, cx: &mut Context<Self>) {
        self.path = path.clone();
        self.loading = true;
        self.ready = false;
        self.source = Rc::new(Source::default());
        self.notice = "Reading file…".into();
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let task = cx
            .background_executor()
            .spawn(async move { requests::read(&client, &workspace, &path) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(source) => {
                        this.source = Rc::new(source);
                        this.ready = true;
                        this.notice = if this.source.truncated {
                            "Preview truncated"
                        } else if this.source.content.is_empty() && !this.source.binary {
                            "Empty file"
                        } else {
                            ""
                        }
                        .into();
                        this.scroll = UniformListScrollHandle::new();
                    }
                    Err(requests::ReadError::TooLarge) => {
                        this.notice = "File exceeds 32 MiB".into()
                    }
                    Err(requests::ReadError::Unavailable) => {
                        this.notice = "Could not read file".into()
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn browse(&mut self, directory: String, cx: &mut Context<Self>) {
        self.browsing = true;
        self.browse_notice = "Reading folder…".into();
        self.browse_generation += 1;
        let generation = self.browse_generation;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let selected = directory.clone();
        let task = cx
            .background_executor()
            .spawn(async move { requests::entries(&client, &workspace, &selected) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.browse_generation {
                    return;
                }
                this.browsing = false;
                match result {
                    Ok(entries) => {
                        this.entries = entries;
                        this.directory = directory;
                        this.browse_notice.clear();
                    }
                    Err(_) => this.browse_notice = "Could not read folder".into(),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn copy(&self, cx: &mut App) {
        if self.ready && self.source.copyable() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.source.content.clone()));
        }
    }
    #[cfg(test)]
    pub(crate) fn test_hidden_source(&self, _: &App) -> bool {
        self.source.masked && self.source.content == "[masked]"
    }
    #[cfg(test)]
    pub(crate) fn test_path_input_matches_source(&self, cx: &App) -> bool {
        self.path_input.read(cx).text == self.path
    }
    #[cfg(test)]
    pub(crate) fn test_ready(&self, path: &str, truncated: bool) -> bool {
        self.ready && !self.loading && self.path == path && self.source.truncated == truncated
    }
    #[cfg(test)]
    pub(crate) fn test_bounded(&self) -> bool {
        self.source.content.chars().count() <= 100_000
            && self
                .source
                .lines
                .iter()
                .all(|line| line.text.chars().count() <= 2_049)
    }
    #[cfg(test)]
    pub(crate) fn test_styled(&self) -> bool {
        self.source.lines.iter().any(|line| !line.styles.is_empty())
    }
    #[cfg(test)]
    pub(crate) fn test_horizontal_scrolled(&self) -> bool {
        self.scroll.0.borrow().base_handle.offset().x < px(0.)
    }
}
fn button(id: &'static str, label: &'static str, enabled: bool) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .px(px(8.))
        .py(px(5.))
        .rounded(px(5.))
        .bg(theme().surface_raised)
        .text_color(if enabled {
            theme().text
        } else {
            theme().text_muted
        })
        .when(enabled, |v| v.cursor_pointer())
        .child(label)
}
impl Render for Files {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let source = self.source.clone();
        let rows = source.lines.len();
        let content_width = source
            .lines
            .iter()
            .map(|line| line.text.chars().count())
            .max()
            .unwrap_or(0) as f32
            * 8.
            + 48.;
        div().size_full().flex().flex_col().bg(theme().background).text_color(theme().text)
            .font_family(theme().font_ui).text_size(px(13.))
            .child(div().flex().items_center().gap(px(8.)).p(px(8.))
                .child(div().id("file-path").debug_selector(|| "file-path".into()).flex_1().min_w_0().child(self.path_input.clone()))
                .child(button("file-open", "Open", !self.loading).on_click(cx.listener(|s, _, _, cx| s.open(cx))))
                .child(button("file-refresh", "Refresh", !self.loading && !self.path.is_empty()).on_click(cx.listener(|s, _, _, cx| { if !s.path.is_empty() && !s.loading { s.read(s.path.clone(), cx); } })))
                .child(button("file-copy", "Copy", self.ready && source.copyable()).on_click(cx.listener(|s, _, _, cx| s.copy(cx)))))
            .child(div().flex().flex_1().min_h_0()
                .child(div().w(px(200.)).flex_shrink_0().flex().flex_col().border_r_1().border_color(theme().border)
                    .child(div().flex().gap(px(8.)).p(px(8.))
                        .child(button("file-up", "Up", !self.directory.is_empty() && !self.browsing).on_click(cx.listener(|s, _, _, cx| {
                            if !s.directory.is_empty() && !s.browsing { let parent = std::path::Path::new(&s.directory).parent().unwrap_or(std::path::Path::new("")).to_string_lossy().into_owned(); s.browse(parent, cx); }
                        })))
                        .child(button("file-browse-retry", "Refresh", !self.browsing).on_click(cx.listener(|s, _, _, cx| s.browse(s.directory.clone(), cx)))))
                    .when(!self.browse_notice.is_empty(), |v| v.child(div().px(px(8.)).child(self.browse_notice.clone())))
                    .child(div().id("file-browser").flex_1().min_h_0().overflow_y_scroll()
                        .children(self.entries.iter().enumerate().map(|(index, entry)| {
                            let path = entry.path.clone(); let folder = entry.directory;
                            let label = if folder { format!("{}/", entry.name) } else { entry.name.clone() };
                            div().id(("file-entry", index)).debug_selector(move || format!("file-entry-{index}"))
                                .px(px(8.)).py(px(5.)).cursor_pointer().hover(|v| v.bg(theme().selection)).child(label)
                                .on_click(cx.listener(move |s, _, _, cx| { if folder { s.browse(path.clone(), cx); } else {
                                    s.path_input.update(cx, |input, cx| { input.clear(cx); input.text = path.clone(); cx.notify(); }); s.read(path.clone(), cx);
                                } }))
                        }))))
                .child(div().flex_1().min_w_0().flex().flex_col()
                    .when(!self.notice.is_empty(), |v| v.child(div().p(px(8.)).text_color(theme().text_muted).child(self.notice.clone())))
                    .when(!self.loading && !self.ready && !self.path.is_empty(), |v| v.child(button("file-retry", "Retry", true).on_click(cx.listener(|s, _, _, cx| s.read(s.path.clone(), cx)))))
                    .when(source.binary, |v| v.child(div().id("file-binary").debug_selector(|| "file-binary".into()).p(px(12.)).child("Binary file")))
                    .when(source.masked, |v| v.child(div().id("file-masked").debug_selector(|| "file-masked".into()).p(px(12.)).child("[masked]")))
                    .when(self.ready && !source.binary && !source.masked, |v| v.child(div().id("file-source").debug_selector(|| "file-source".into())
                        .track_focus(&self.focus).flex_1().min_h_0().overflow_hidden()
                        .on_mouse_down(MouseButton::Left, cx.listener(|s, _, window, _| s.focus.focus(window)))
                        .on_key_down(cx.listener(|s, event: &KeyDownEvent, window, cx| {
                            if s.focus.is_focused(window) && (event.keystroke.modifiers.control || event.keystroke.modifiers.platform) && event.keystroke.key == "c" { s.copy(cx); cx.stop_propagation(); }
                        }))
                        .child(uniform_list("file-lines", rows, move |range, _, _| range.map(|index| {
                            let line = &source.lines[index];
                            div().flex().min_w(px(content_width)).h(px(20.)).font_family(theme().font_mono).text_size(px(13.))
                                .child(div().w(px(48.)).flex_shrink_0().text_color(theme().text_muted).child((index + 1).to_string()))
                                .child(StyledText::new(line.text.clone()).with_highlights(line.styles.iter().map(|(range, style)| (range.clone(), HighlightStyle { color: Some(style.color().into()), ..Default::default() }))))
                        }).collect()).with_horizontal_sizing_behavior(ListHorizontalSizingBehavior::Unconstrained).track_scroll(self.scroll.clone()).size_full())))))
    }
}
