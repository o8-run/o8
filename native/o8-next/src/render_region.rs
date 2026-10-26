//! Retained sibling regions. Only owner notifications invalidate their scene.
//! Unchanged siblings reuse GPUI layout, input dispatch and painted text. Bounds
//! and inherited text style remain part of GPUI's cache key.
use gpui::{prelude::*, *};
use std::{cell::Cell, collections::HashMap, rc::Rc};

type Renderer<V> = fn(&mut V, &mut Window, &mut Context<V>) -> AnyElement;
pub(crate) struct Regions<V: 'static>(HashMap<&'static str, Entity<Region<V>>>);
impl<V: 'static> Default for Regions<V> {
    fn default() -> Self {
        Self(HashMap::new())
    }
}
struct Region<V: 'static> {
    owner: WeakEntity<V>,
    render: Renderer<V>,
    measured: Option<Rc<Cell<Option<Pixels>>>>,
    width: Pixels,
    _subscription: Subscription,
    #[cfg(test)]
    renders: usize,
}
impl<V: 'static> Regions<V> {
    pub(crate) fn view(
        &mut self,
        id: &'static str,
        style: StyleRefinement,
        render: Renderer<V>,
        cx: &mut Context<V>,
    ) -> AnyView {
        self.region(id, style, render, None, cx)
    }
    // Chrome with wrapping rows measures its intrinsic height on model or
    // viewport changes, then retains that height for subsequent editor frames.
    pub(crate) fn measured_view(
        &mut self,
        id: &'static str,
        style: StyleRefinement,
        render: Renderer<V>,
        width: Pixels,
        cx: &mut Context<V>,
    ) -> AnyView {
        self.region(id, style, render, Some(width), cx)
    }
    fn region(
        &mut self,
        id: &'static str,
        mut style: StyleRefinement,
        render: Renderer<V>,
        width: Option<Pixels>,
        cx: &mut Context<V>,
    ) -> AnyView {
        let view = self.0.entry(id).or_insert_with(|| {
            let owner = cx.entity();
            cx.new(|cx| Region {
                owner: owner.downgrade(),
                render,
                measured: width.map(|_| Rc::new(Cell::new(None))),
                width: width.unwrap_or_default(),
                _subscription: cx.observe(&owner, |this: &mut Region<V>, _, cx| {
                    if let Some(measured) = &this.measured {
                        measured.set(None);
                    }
                    cx.notify();
                }),
                #[cfg(test)]
                renders: 0,
            })
        });
        if let Some(width) = width {
            let height = view.update(cx, |view, _| {
                let measured = view.measured.as_ref().unwrap();
                if view.width != width {
                    view.width = width;
                    measured.set(None);
                }
                measured.get()
            });
            if let Some(height) = height {
                style.size.height = Some(height.into());
            } else {
                return AnyView::from(view.clone());
            }
        }
        AnyView::from(view.clone()).cached(style)
    }
    #[cfg(test)]
    pub(crate) fn renders(&self, cx: &App) -> Vec<(&'static str, usize)> {
        let mut counts: Vec<_> = self
            .0
            .iter()
            .map(|(&id, v)| (id, v.read(cx).renders))
            .collect();
        counts.sort_unstable();
        counts
    }
}
impl<V: 'static> Render for Region<V> {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(test)]
        {
            self.renders += 1;
        }
        let content = self
            .owner
            .update(cx, |owner, cx| (self.render)(owner, window, cx))
            .unwrap();
        if let Some(measured) = self.measured.clone() {
            let view = cx.entity();
            div()
                .relative()
                .w_full()
                .flex_shrink_0()
                .child(content)
                .child(
                    canvas(
                        |_, _, _| (),
                        move |bounds, _, _, cx| {
                            if measured.replace(Some(bounds.size.height))
                                != Some(bounds.size.height)
                            {
                                view.update(cx, |_, cx| cx.notify());
                            }
                        },
                    )
                    .absolute()
                    .inset_0(),
                )
                .into_any_element()
        } else {
            content
        }
    }
}
