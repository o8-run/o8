//! Window-owned system material. Plain hosts retain an opaque root.
use crate::theme;
use gpui::{
    Bounds, Pixels, Window, WindowBackgroundAppearance, canvas, div, linear_color_stop,
    linear_gradient, point, prelude::*, size,
};

#[cfg(target_os = "macos")]
#[path = "shell_material_macos.rs"]
mod macos;

pub(super) fn background(offscreen: bool) -> WindowBackgroundAppearance {
    #[cfg(target_os = "macos")]
    let reduced = !offscreen && theme::glass() && macos::reduced_transparency();
    #[cfg(not(target_os = "macos"))]
    let reduced = false;
    background_for(offscreen, reduced)
}

pub(super) fn background_for(offscreen: bool, reduced: bool) -> WindowBackgroundAppearance {
    if cfg!(target_os = "macos") && theme::glass() && !offscreen && !reduced {
        WindowBackgroundAppearance::Transparent
    } else {
        WindowBackgroundAppearance::Opaque
    }
}

pub(super) fn apply(window: &mut Window, offscreen: bool) -> bool {
    #[cfg(target_os = "macos")]
    let reduced = !offscreen && theme::glass() && macos::reduced_transparency();
    #[cfg(not(target_os = "macos"))]
    let reduced = false;
    apply_for(window, offscreen, reduced)
}

pub(super) fn apply_for(window: &mut Window, offscreen: bool, reduced: bool) -> bool {
    let background = background_for(offscreen, reduced);
    window.set_background_appearance(background);
    if background == WindowBackgroundAppearance::Opaque {
        return false;
    }
    #[cfg(target_os = "macos")]
    if macos::install(window) {
        return true;
    }
    window.set_background_appearance(WindowBackgroundAppearance::Opaque);
    false
}

pub(super) fn veil() -> gpui::AnyElement {
    // GPUI 0.2.2 has two-stop gradients. Two contiguous pieces preserve the
    // desktop's middle stop exactly, without layers of alpha or a blur shader.
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .child(
            canvas(
                |bounds, _, _| bounds,
                |bounds: Bounds<Pixels>, _, window, _| {
                    for stops in theme::GLASS_VEIL.windows(2) {
                        let [(start, from), (end, to)] = stops else {
                            unreachable!()
                        };
                        let quad = Bounds::new(
                            point(
                                bounds.origin.x,
                                bounds.origin.y + bounds.size.height * *start,
                            ),
                            size(bounds.size.width, bounds.size.height * (*end - *start)),
                        );
                        window.paint_quad(gpui::fill(
                            quad,
                            linear_gradient(
                                180.,
                                linear_color_stop(theme::veil_color(*from), 0.),
                                linear_color_stop(theme::veil_color(*to), 1.),
                            ),
                        ));
                    }
                },
            )
            .size_full(),
        )
        .into_any_element()
}
