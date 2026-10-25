use super::*;

pub(super) struct Readout {
    values: [String; 4],
    sample: Rc<RefCell<Sample>>,
    generation: u64,
}
impl Readout {
    pub(super) fn new(sample: Rc<RefCell<Sample>>) -> Self {
        let generation = sample.borrow().generation;
        Self {
            sample,
            generation,
            values: std::array::from_fn(|_| "—".into()),
        }
    }
    pub(super) fn publish(&mut self, values: [String; 4], cx: &mut Context<Self>) -> bool {
        if self.values == values {
            return false;
        }
        self.values = values;
        cx.notify();
        true
    }
}
impl Render for Readout {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let sample = self.sample.clone();
        let generation = self.generation;
        div()
            .id("speed-panel")
            .debug_selector(|| "speed-panel".into())
            .size_full()
            .flex()
            .flex_wrap()
            .p(px(8.))
            .rounded(px(7.))
            .bg(theme().surface_raised)
            .text_color(theme().text)
            .text_size(px(11.))
            .font_weight(gpui::FontWeight::LIGHT)
            .children(
                ["speed-key", "speed-frame", "speed-wakeups", "speed-memory"]
                    .into_iter()
                    .zip(self.values.iter())
                    .map(|(id, value)| {
                        div()
                            .debug_selector(move || id.into())
                            .w(px(80.))
                            .text_right()
                            .h(px(20.))
                            .child(value.clone())
                    }),
            )
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, _, _, _| {
                        let mut sample = sample.borrow_mut();
                        if sample.enabled && sample.generation == generation {
                            sample.readout_frame = false;
                        }
                    },
                )
                .size(px(1.))
                .absolute(),
            )
    }
}
