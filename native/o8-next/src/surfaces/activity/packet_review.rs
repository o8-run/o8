use super::*;
impl ActivityPane {
    pub(super) fn packet_review(
        &mut self,
        row: &Row,
        read: &packet::Review,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let review = &row.data["review"];
        let verdict = if review.is_null() {
            "Review pending"
        } else if review["approved"] == true {
            "Approved"
        } else {
            "Changes requested"
        };
        let mut view = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .border_t_1()
            .border_color(theme().border)
            .pt(px(8.))
            .debug_selector(|| "activity-packet-review".to_string())
            .child(
                div()
                    .text_size(px(11.))
                    .font_weight(FontWeight(450.))
                    .child(verdict),
            );
        for field in [
            "summary",
            "note",
            "findings",
            "feedback",
            "directivesApplied",
            "directivesViolated",
            "directiveViolations",
            "verifierResults",
        ] {
            let value = copy_value(&review[field]);
            if !value.is_empty() {
                view = view.child(label(value));
            }
        }
        if !read.diff.is_null() {
            view = view
                .child(label(text(&read.diff, "stat")))
                .child(self.button(
                    "activity-packet-review-diff",
                    "Open review diff",
                    Action::Packet(Packet::Diff(row.clone())),
                    cx,
                ));
        }
        let directives = read
            .directives
            .as_array()
            .or(read.directives["directives"].as_array());
        if let Some(directives) = directives {
            for directive in directives {
                let value = directive_text(directive);
                if !value.is_empty() {
                    view = view.child(label(format!("Directive · {value}")));
                }
            }
        }
        view.into_any_element()
    }
}
