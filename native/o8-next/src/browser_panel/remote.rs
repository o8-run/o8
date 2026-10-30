//! NativeRemotePreview + RemoteTaskPreview. No Browser tab, eval or saved URL.
use super::*;
use std::sync::Arc;
mod client;
mod web;
use client::{Access, Owner, Task, Update};
pub(super) struct Closed;
pub(super) struct RemotePreview {
    client: crate::client::Client,
    tasks: Vec<Task>,
    loading: bool,
    stage: String,
    selected: Option<Task>,
    connecting: bool,
    error: Option<String>,
    access: Option<Access>,
    host_error: Rc<RefCell<Option<String>>>,
    owner: Option<Arc<Owner>>,
    host: Rc<RefCell<Option<web::Host>>>,
    covered: Rc<std::cell::Cell<bool>>,
}
impl EventEmitter<Closed> for RemotePreview {}
impl Drop for RemotePreview {
    fn drop(&mut self) {
        self.host.borrow_mut().take();
        if let Some(owner) = self.owner.take() {
            owner.cancel();
        }
    }
}
impl BrowserPanel {
    pub(super) fn open_remote(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        self.hide_pages();
        let remote = cx.new(|cx| RemotePreview::new(client, cx));
        self._subscriptions
            .push(cx.subscribe(&remote, |this, _, _: &Closed, cx| {
                this.remote = None;
                cx.notify();
            }));
        self.remote = Some(remote);
        cx.notify();
    }
}
impl RemotePreview {
    fn new(client: crate::client::Client, cx: &mut Context<Self>) -> Self {
        let request = client.clone();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                if this
                    .update(cx, |this, cx| {
                        let error = this.host_error.borrow_mut().take();
                        if let Some(error) = error {
                            this.error = Some(error);
                            this.host.borrow_mut().take();
                            if let Some(owner) = this.owner.take() {
                                owner.cancel();
                            }
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    if cfg!(target_os = "macos") || cfg!(test) {
                        client::tasks(&request)
                    } else {
                        Err("Remote previews currently require macOS.".into())
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(tasks) => this.tasks = tasks,
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
        Self {
            client,
            tasks: vec![],
            loading: true,
            stage: "Loading remote previews…".into(),
            selected: None,
            connecting: false,
            error: None,
            access: None,
            owner: None,
            host_error: Rc::default(),
            host: Rc::default(),
            covered: Rc::default(),
        }
    }
    pub(super) fn cover(&self, covered: bool) {
        self.covered.set(covered);
        if covered {
            if let Some(host) = self.host.borrow().as_ref() {
                host.hide();
            }
        }
    }
    fn connect(&mut self, task: Task, reconnect: bool, cx: &mut Context<Self>) {
        self.host.borrow_mut().take();
        self.access = None;
        self.error = None;
        self.connecting = true;
        self.stage = if reconnect {
            "Reconnecting to the service…"
        } else {
            "Checking preview support…"
        }
        .into();
        self.selected = Some(task.clone());
        let owner = if reconnect {
            self.owner
                .clone()
                .unwrap_or_else(|| Owner::new(self.client.clone(), task.clone()))
        } else {
            if let Some(owner) = self.owner.take() {
                owner.cancel();
            }
            Owner::new(self.client.clone(), task)
        };
        self.owner = Some(owner.clone());
        let (tx, rx) = async_channel::unbounded();
        let worker = owner.clone();
        std::thread::spawn(move || worker.connect(reconnect, tx));
        cx.spawn(async move |this, cx| {
            while let Ok(update) = rx.recv().await {
                if this
                    .update(cx, |this, cx| {
                        match update {
                            Update::Progress(stage) => this.stage = stage,
                            Update::Ready(access) => {
                                this.access = Some(access);
                                this.connecting = false;
                            }
                            Update::Error(error) => {
                                this.error = Some(error);
                                this.connecting = false;
                                if let Some(owner) = this.owner.take() {
                                    owner.cancel();
                                }
                            }
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    owner.cancel();
                    break;
                }
            }
        })
        .detach();
        cx.notify();
    }
}
fn button(
    id: &'static str,
    label: &'static str,
    enabled: bool,
    cx: &Context<RemotePreview>,
) -> Stateful<Div> {
    header::keyboard_button(
        div()
            .id(id)
            .debug_selector(move || id.into())
            .px(px(10.))
            .py(px(5.))
            .rounded(px(6.))
            .text_size(px(11.))
            .text_color(if enabled {
                theme().text
            } else {
                theme().text_faint
            })
            .bg(theme().hover)
            .when(enabled, |d| {
                d.cursor_pointer().hover(|d| d.bg(theme().selection))
            })
            .child(label),
        cx,
    )
}
impl Render for RemotePreview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let host = self.host.clone();
        let covered = self.covered.clone();
        let access = self.access.clone();
        let host_error = self.host_error.clone();
        let connecting = self.connecting;
        let connected = self.access.is_some() && self.error.is_none();
        div().id("browser-remote-preview").debug_selector(|| "browser-remote-preview".into()).size_full().p(px(6.))
            .flex().flex_col().gap(px(8.)).text_color(theme().text).font_family(theme().font_ui).font_weight(FontWeight::LIGHT)
            .child(div().id("browser-remote-heading").debug_selector(move || if connected { "browser-remote-connected" } else { "browser-remote-heading" }.into()).text_size(px(11.)).text_color(theme().text_muted).child(self.selected.as_ref().map_or("Remote previews".into(),|task| format!("Remote preview · attempt {}{}",task.execution.as_ref().map_or(0,|e|e.attempt),self.access.as_ref().and_then(|a|a.service.as_ref()).map_or(String::new(),|s|format!(" · {s}"))))))
            .child(div().flex_1().min_h_0().relative().overflow_hidden()
                .when(self.loading || connecting,|d| d.child(div().text_size(px(12.)).child(self.stage.clone())))
                .when(self.error.is_some(),|d| d.child(div().id("browser-remote-error").debug_selector(|| "browser-remote-error".into()).text_size(px(12.)).child(self.error.clone().unwrap_or_default())))
                .when(!self.loading && self.selected.is_none() && self.error.is_none(),|d| d
                    .when(self.tasks.is_empty(),|d|d.child(div().id("browser-remote-empty").debug_selector(|| "browser-remote-empty".into()).text_size(px(12.)).text_color(theme().text_muted).child("No remote previews available")))
                    .children(self.tasks.iter().enumerate().map(|(index,task)| {
                        let task=task.clone();
                        header::keyboard_button(div().id(("browser-remote-task",index)).debug_selector(move ||format!("browser-remote-task-{index}"))
                            .px(px(12.)).py(px(10.)).rounded(px(8.)).border_1().border_color(theme().border).bg(theme().surface_raised)
                            .text_size(px(13.5)).cursor_pointer().hover(|d|d.bg(theme().hover)).child(task.title.clone()),cx)
                            .on_click(cx.listener(move |this,_,_,cx| this.connect(task.clone(),false,cx)))
                    })))
                .when(self.access.is_some() && self.error.is_none(),|d| d.child(canvas(|bounds,_,_| bounds,move |bounds:Bounds<Pixels>,_,window,_| {
                    let mut host=host.borrow_mut();
                    if host.is_none() { if let Some(access)=access.as_ref() { *host=web::Host::new(access,window,host_error.clone()); if host.is_none() && !cfg!(test) { *host_error.borrow_mut()=Some("The native preview could not open. Reconnect to try again.".into()); } } }
                    if let Some(host)=host.as_ref() { if covered.get() { host.hide(); } else { host.position(bounds,window); } }
                }).absolute().top_0().left_0().size_full())))
            .child(div().text_size(px(10.5)).text_color(theme().text_faint).child("Read-only HTTP preview. Review services stop when you leave and expire after ten minutes. Streaming connections are not supported yet."))
            .child(div().flex().justify_end().gap(px(6.))
                .child(button("browser-remote-back","Back",true,cx).on_click(cx.listener(|_,_,_,cx|cx.emit(Closed))))
                .when(self.selected.is_some(),|d|d.child(button("browser-remote-reconnect",if connecting {"Connecting…"}else{"Reconnect"},!connecting,cx)
                    .on_click(cx.listener(|this,_,_,cx| { if !this.connecting { if let Some(task)=this.selected.clone() { this.connect(task,true,cx); } } }))))
        )
    }
}
