use super::*;

pub(super) fn layout(
    b: &mut Builder,
    width: Pixels,
    nodes: &[Node],
    expanded: bool,
    window: &Window,
) {
    // The desktop user bubble: right-aligned and sized to its text, at most
    // 80% of the reading column.
    let pad = px(12.);
    let top = b.y + px(4.);
    let mut bubble = Builder {
        row_id: b.row_id.clone(),
        image_cache: b.image_cache.clone(),
        width: ((width - px(48.)) * 0.8).max(px(1.)) + px(48.),
        y: top + px(8.),
        lines: vec![],
        backgrounds: vec![],
        images: vec![],
        gap_end: None,
    };
    for node in super::trimmed(nodes) {
        bubble.node(node, expanded, window);
    }
    let text = bubble
        .lines
        .iter()
        .map(|line| line.origin.x - px(24.) + line.line.width())
        .chain(
            bubble
                .images
                .iter()
                .map(|image| image.bounds.right() - px(24.)),
        )
        .fold(px(1.), Pixels::max);
    let right = width - px(24.);
    let shift = right - pad - text - px(24.);
    b.backgrounds.push(Backdrop {
        bounds: Bounds::new(
            point(right - text - pad * 2., top),
            size(text + pad * 2., bubble.y - top + px(8.)),
        ),
        color: theme().selection,
        radius: px(14.),
    });
    for mut background in bubble.backgrounds {
        // Rich nodes were measured at the maximum user-column width. Fit their
        // backdrops to the measured bubble before translating them rightward.
        let available = (px(24.) + text - background.bounds.left()).max(px(0.));
        background.bounds.size.width = background.bounds.size.width.min(available);
        background.bounds.origin.x += shift;
        b.backgrounds.push(background);
    }
    for mut line in bubble.lines {
        line.origin.x += shift;
        b.lines.push(line);
    }
    // Pictures share the text's left edge inside the bubble.
    for mut image in bubble.images {
        image.bounds.origin.x += shift;
        b.images.push(image);
    }
    b.y = bubble.y + px(16.);
}
