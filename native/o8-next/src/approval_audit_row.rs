use super::*;

pub(super) fn audit_row(row: Row, index: usize) -> impl IntoElement {
    let event = &row.event;
    let review = text(event, "type") == "orchestrator_review";
    let verdict = event["approved"].as_bool().map(|approved| {
        if approved {
            "Approved"
        } else {
            "Changes Requested"
        }
    });
    div()
        .id(("approval-audit-row", index))
        .debug_selector(move || format!("approval-audit-row-{index}"))
        .flex()
        .flex_col()
        .gap(px(6.))
        .mb(px(12.))
        .p(px(12.))
        .rounded(px(8.))
        .bg(palette().surface_raised)
        .child(div().text_size(px(13.5)).child(row.title))
        .child(
            div()
                .text_size(px(11.))
                .text_color(palette().text_muted)
                .child(format!(
                    "{} · {} risk · {}",
                    label(&text(event, "type")),
                    label(&row.risk),
                    timestamp(row.timestamp)
                )),
        )
        .child(div().text_size(px(11.)).child(format!(
            "Actor: {} · Session: {} · ID: {}",
            label(&text(event, "actor")),
            row.session,
            row.approval_id
        )))
        .when_some(verdict, |v, verdict| {
            v.child(div().child(format!("Verdict: {verdict}")))
        })
        .when(!text(event, "reviewer").is_empty(), |v| {
            v.child(div().child(format!("Reviewer: {}", text(event, "reviewer"))))
        })
        .when(!text(event, "diffSha").is_empty(), |v| {
            v.child(div().child(format!("Diff SHA: {}", text(event, "diffSha"))))
        })
        .when(!text(event, "reviewedHeadSha").is_empty(), |v| {
            v.child(div().child(format!("Reviewed HEAD: {}", text(event, "reviewedHeadSha"))))
        })
        .when(!text(event, "note").is_empty(), |v| {
            v.child(
                div()
                    .text_size(px(11.5))
                    .child(format!("Note: {}", text(event, "note"))),
            )
        })
        .when(review, |v| {
            v.child(
                div()
                    .text_size(px(11.))
                    .text_color(palette().text_muted)
                    .child("Findings"),
            )
        })
        .when(
            review && event["findings"].as_array().is_none_or(Vec::is_empty),
            |v| v.child(div().child("No structured findings were recorded for this review.")),
        )
        .children(
            event["findings"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|finding| {
                    let location = match finding["line"].as_u64() {
                        Some(line) => format!("{}:{line}", text(finding, "file")),
                        None => text(finding, "file"),
                    };
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .p(px(8.))
                        .rounded(px(7.))
                        .bg(palette().background)
                        .child(div().text_size(px(11.)).child(format!(
                            "{} · {} · {location}",
                            label(&text(finding, "severity")),
                            label(&text(finding, "resolution"))
                        )))
                        .child(
                            div()
                                .text_size(px(11.5))
                                .child(text(finding, "description")),
                        )
                        .when(!text(finding, "fixSuggestion").is_empty(), |v| {
                            v.child(div().text_size(px(11.5)).child(format!(
                                "Suggested fix: {}",
                                text(finding, "fixSuggestion")
                            )))
                        })
                }),
        )
}
