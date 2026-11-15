//! Construction shared by packet review and a worker’s working-tree inspector.
use super::*;

impl DiffSurface {
    pub(crate) fn new(
        client: Client,
        target: Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self::in_lane(client, target, None, window, cx)
    }
    pub(crate) fn in_lane(
        client: Client,
        target: Target,
        lane_context: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window);
        let request_changes = match &target {
            Target::Packet(packet) => Some(cx.new(|cx| {
                crate::request_changes::RequestChanges::new(client.clone(), packet.clone(), cx)
            })),
            _ => None,
        };
        let observer = request_changes
            .as_ref()
            .map(|control| cx.observe(control, |_, _, cx| cx.notify()));
        let mut surface = Self {
            request_changes,
            _request_changes_observer: observer,
            discard_allowed: true,
            client,
            map: Default::default(),
            target,
            document: Rc::new(Document::default()),
            selected: 0,
            split: false,
            ready: false,
            failed: false,
            busy: false,
            missing: None,
            discarded_lanes: BTreeSet::new(),
            lane_context,
            generation: 0,
            pending: None,
            state: Value::Null,
            notice: String::new(),
            focus,
            scroll: UniformListScrollHandle::new(),
            painted: Rc::new(RefCell::new(BTreeSet::new())),
            stack: Rc::new(vec![]),
            chosen: HashMap::new(),
            limit_note: None,
            scope: Scope::All,
            scope_paths: None,
            scope_error: None,
            scope_generation: 0,
            drawer: None,
            width: px(0.),
            stack_scroll: gpui::ScrollHandle::new(),
            stack_target: None,
        };
        surface.load(cx);
        surface
    }
}
