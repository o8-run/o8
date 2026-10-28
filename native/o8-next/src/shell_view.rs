use super::*;
#[path = "shell_geometry.rs"]
mod geometry;
use crate::theme::current as theme;
impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for extension in registry::extensions() {
            extension.prepare(self, window, cx);
        }
        let frame = registry::extensions()
            .find_map(|extension| extension.frame(self))
            .unwrap_or_default();
        if !registrations().iter().any(|r| (r.block_ensure)(self)) {
            self.ensure(window, cx);
        }
        let mut style = gpui::StyleRefinement::default();
        style.size.width = Some(gpui::relative(1.).into());
        style.flex_shrink = Some(0.);
        let chrome = self.chrome.measured_view(
            "shell-chrome",
            style,
            Self::render_chrome,
            window.viewport_size().width,
            cx,
        );
        let slots = features::render_content(self, &frame, chrome.into_any_element(), window, cx);
        div()
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .bg(if self.system_glass {
                theme().background
            } else {
                crate::theme::plain_background()
            })
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(crate::theme::TYPE.weight)
            .text_size(px(crate::theme::TYPE.chrome))
            .line_height(gpui::relative(crate::theme::TYPE.chrome_line))
            .track_focus(&self.focus)
            .map(|root| features::bind_input(root, self, cx))
            .children(slots)
    }
}

impl Shell {
    fn render_chrome(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let frame = registry::extensions()
            .find_map(|extension| extension.frame(self))
            .unwrap_or_default();
        div()
            .w_full()
            .flex()
            .flex_col()
            .children(features::render_chrome(self, &frame, window, cx))
            .into_any_element()
    }
}

pub fn try_launch(args: &[String]) -> Result<bool, String> {
    if !args
        .iter()
        .any(|a| a == "--app-shell" || a == "--shell-state")
    {
        return Ok(false);
    }
    let (mut enabled, mut shell, mut offscreen) = (false, false, false);
    let (mut server, mut file) = (None, None);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--enable-next" => enabled = true,
            "--app-shell" => shell = true,
            "--offscreen" => offscreen = true,
            flag @ ("--server" | "--shell-state") => {
                i += 1;
                let value = args
                    .get(i)
                    .filter(|v| !v.starts_with("--"))
                    .ok_or("Missing shell flag value")?
                    .clone();
                if flag == "--server" {
                    if server.replace(value).is_some() {
                        return Err("Duplicate shell server".into());
                    }
                } else if file.replace(PathBuf::from(value)).is_some() {
                    return Err("Duplicate shell state".into());
                }
            }
            _ => {
                return Err(
                    "App shell accepts only server, state, opt-in and offscreen flags".into(),
                );
            }
        }
        i += 1;
    }
    if !enabled || !shell {
        return Err("App shell requires --enable-next and --app-shell".into());
    }
    let file = file
        .filter(|p| p.is_absolute())
        .ok_or("Pass --shell-state with an absolute file")?;
    let state = State::load(&file)?;
    let client = Client::new(
        &server.ok_or("Pass --server; use o8 next for local configuration discovery")?,
    )?;
    launch(client, file, state, offscreen);
    Ok(true)
}
fn launch(client: Client, file: PathBuf, state: State, offscreen: bool) {
    (if offscreen {
        Application::headless()
    } else {
        Application::new()
    })
    .run(move |cx: &mut App| {
        let (sender, receiver) = async_channel::bounded(1);
        let client = client.with_wakeup(sender);
        let handle = open_window(client, file, state, offscreen, cx);
        start_pump(handle, receiver, cx);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
    });
}

pub(super) fn start_pump(
    handle: gpui::WindowHandle<Shell>,
    receiver: async_channel::Receiver<()>,
    cx: &mut App,
) {
    cx.spawn(async move |cx| {
        let mut timer = cx.background_executor().timer(Duration::from_secs(1));
        loop {
            let refresh = crate::wake::next(&receiver, &mut timer).await;
            if refresh {
                timer = cx.background_executor().timer(Duration::from_secs(1));
            }
            if handle
                .update(cx, |s, window, cx| s.tick(refresh, window, cx))
                .is_err()
            {
                break;
            }
        }
    })
    .detach();
}

pub(super) fn open_window(
    client: Client,
    file: PathBuf,
    mut state: State,
    offscreen: bool,
    cx: &mut App,
) -> gpui::WindowHandle<Shell> {
    let [x, y, w, h] = state.bounds;
    let bounds = geometry::visible(
        Bounds::new(point(px(x), px(y)), size(px(w), px(h))),
        &cx.displays()
            .iter()
            .map(|display| display.bounds())
            .collect::<Vec<_>>(),
    );
    state.bounds = [
        bounds.origin.x.into(),
        bounds.origin.y.into(),
        bounds.size.width.into(),
        bounds.size.height.into(),
    ];
    cx.open_window(
        WindowOptions {
            window_background: material::background(offscreen),
            focus: false,
            show: !offscreen,
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(600.), px(400.))),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("o8 next".into()),
                ..Default::default()
            }),
            ..Default::default()
        },
        |window, cx| {
            let system_glass = material::apply(window, offscreen);
            geometry::restore_size(window, bounds.size);
            cx.new(|cx| {
                let mut shell = Shell::new(client, file, state, window, cx);
                shell.system_glass = system_glass;
                shell
            })
        },
    )
    .expect("GPUI shell window")
}
