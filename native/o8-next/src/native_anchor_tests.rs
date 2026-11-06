//! Native views draw above the whole window. A paint-order anchor tells such a
//! view which parts later window content (menus, tooltips, dialogs) painted over.
use gpui::{
    AppContext, Bounds, Context, Entity, IntoElement, Render, Styled, TestAppContext, Window,
    canvas, div, point, prelude::*, px, rgb, size,
};
use std::{cell::Cell, rc::Rc};

const KEY: u64 = 7;

struct Card {
    painted: bool,
}

impl Render for Card {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let painted = self.painted;
        // Drawn before the anchor: never counts as covering it.
        div().size_full().bg(rgb(0x202020)).child(
            canvas(
                |_, _, _| {},
                move |bounds, _, window, _| {
                    if painted {
                        window.paint_native_anchor(KEY, bounds)
                    }
                },
            )
            .absolute()
            .left(px(10.))
            .top(px(10.))
            .w(px(200.))
            .h(px(100.)),
        )
    }
}

struct Root {
    card: Entity<Card>,
    menu: bool,
}

impl Render for Root {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .child(
                gpui::AnyView::from(self.card.clone())
                    .cached(gpui::StyleRefinement::default().size_full()),
            )
            // A transparent overlay paints nothing over the document.
            .child(div().absolute().left_0().top_0().w(px(400.)).h(px(400.)))
            .when(self.menu, |root| {
                root.child(
                    div()
                        .absolute()
                        .left(px(150.))
                        .top(px(60.))
                        .w(px(100.))
                        .h(px(100.))
                        .bg(rgb(0xffffff)),
                )
            })
    }
}

fn cover(cx: &mut gpui::VisualTestContext) -> Option<Vec<Bounds<gpui::Pixels>>> {
    // No refresh: views that were not notified reuse their cached paint.
    cx.update(|window, cx| {
        window.draw(cx).clear();
        window.native_anchor_cover(KEY)
    })
}

#[gpui::test]
fn native_anchor_reports_only_content_painted_above_it(cx: &mut TestAppContext) {
    let (root, cx) = cx.add_window_view(|_, cx| Root {
        card: cx.new(|_| Card { painted: true }),
        menu: false,
    });
    assert_eq!(cover(cx), Some(vec![]));

    root.update(cx, |root, cx| {
        root.menu = true;
        cx.notify();
    });
    // The card view is cached: its replayed paint keeps the anchor in order.
    let menu = Bounds::new(point(px(150.), px(60.)), size(px(60.), px(50.)));
    assert_eq!(cover(cx), Some(vec![menu]));

    let card = root.read_with(cx, |root, _| root.card.clone());
    card.update(cx, |card, cx| {
        card.painted = false;
        cx.notify();
    });
    assert_eq!(cover(cx), None);
}

#[gpui::test]
fn drawn_hook_runs_after_each_frame(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, cx| Root {
        card: cx.new(|_| Card { painted: true }),
        menu: true,
    });
    let seen = Rc::new(Cell::new(None));
    let hook = seen.clone();
    cx.update(|window, cx| {
        window.on_drawn(move |window, _| hook.set(window.native_anchor_cover(KEY)));
        window.draw(cx).clear();
    });
    let covered = seen.take().expect("the hook saw the drawn frame");
    assert_eq!(covered.len(), 1);
}

#[test]
fn uncovered_parts_leave_out_every_cover() {
    use crate::visualizations::uncovered;
    let visible = Bounds::new(point(px(0.), px(0.)), size(px(100.), px(100.)));
    assert_eq!(uncovered(visible, &[]), vec![visible]);
    let menu = Bounds::new(point(px(20.), px(30.)), size(px(40.), px(20.)));
    let tooltip = Bounds::new(point(px(50.), px(40.)), size(px(80.), px(10.)));
    let parts = uncovered(visible, &[menu, tooltip]);
    let area: f32 = parts
        .iter()
        .map(|part| f32::from(part.size.width) * f32::from(part.size.height))
        .sum();
    // 10000 minus the menu (800) minus the tooltip outside the menu (40 x 10).
    assert_eq!(area, 10000. - 800. - 400.);
    for part in &parts {
        assert!(part.intersect(&menu).is_empty() && part.intersect(&tooltip).is_empty());
        assert_eq!(part.intersect(&visible), *part);
        for other in &parts {
            assert!(std::ptr::eq(part, other) || part.intersect(other).is_empty());
        }
    }
    assert_eq!(uncovered(visible, &[visible]), vec![]);
}
