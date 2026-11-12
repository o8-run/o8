use super::*;
impl ActivityPane {
    pub(super) fn packet_map(
        &mut self,
        row: &Row,
        read: &packet::Review,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let id = row.id.clone();
        let map = read
            .map
            .view(&format!("packet-{id}"), cx, move |s, command, cx| {
                let navigate = matches!(
                    command,
                    crate::change_map::Command::Select(_) | crate::change_map::Command::Focus(_)
                );
                if let Some(read) = s.packet.reads.get_mut(&id) {
                    read.map.apply(&command);
                    if navigate && !read.map.selected.is_empty() {
                        s.packet.tabs.insert(id.clone(), "files");
                    }
                }
                s.changed(cx);
            });
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(map)
            .when(
                read.map.error.is_some() || read.map.delta["status"] == "unavailable",
                |v| {
                    v.child(self.button(
                        "activity-packet-map-retry",
                        "Retry change map",
                        Action::Packet(Packet::Read(row.clone())),
                        cx,
                    ))
                },
            )
            .into_any_element()
    }

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
        if !read.map.selected.is_empty() {
            for (path, _, lines) in read
                .patches
                .iter()
                .filter(|(path, old, _)| read.map.keeps(path) || read.map.keeps(old))
            {
                let limit = lines.len().min(300);
                view = view.child(div().debug_selector(|| "activity-map-diff".into()).min_w_0()
                    .child(label(path.clone()).text_ellipsis())
                    .child(crate::files_panel::file_diff::rows(&lines[..limit], false, &format!("packet-map-{path}")))
                    .when(lines.len() > limit, |v| v.child(label("Showing the first 300 lines. Open review diff to read the full file."))));
            }
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
