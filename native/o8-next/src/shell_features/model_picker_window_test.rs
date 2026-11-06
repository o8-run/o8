// The composer's model picker in the real shell window: it keeps its fixed
// size when there is room, and in a short window it stays below the title bar.
use super::*;
use crate::shell::test_support::*;
use gpui::Modifiers;
struct ModelPickerWindowTests;
register_shell_feature!(ModelPickerWindowTests);
impl ShellFeature for ModelPickerWindowTests {}
/// The picker's fixed height (`MODEL_HEIGHT` in the composer's picker).
const MODEL_HEIGHT: f32 = 396.;

fn bounds(v: &mut VisualTestContext, id: &'static str) -> Bounds<gpui::Pixels> {
    draw(v);
    v.debug_bounds(id).unwrap_or_else(|| panic!("missing {id}"))
}

#[gpui::test]
fn native_composer_model_picker_fits_a_short_window(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("model-picker-window.json"),
        crate::shell_state::State::default(),
        cx,
    );
    v.simulate_resize(size(px(1200.), px(900.)));
    ready(&s, &mut v);
    let chip = bounds(&mut v, "composer-model");
    v.simulate_click(chip.center(), Modifiers::default());
    v.run_until_parked();
    // A tall window has room: the picker keeps its fixed size.
    let picker = bounds(&mut v, "composer-picker");
    assert_eq!(picker.size.height, px(MODEL_HEIGHT), "{picker:?}");

    // 480 points tall: the fixed picker would run under the title bar.
    v.simulate_resize(size(px(1200.), px(480.)));
    v.run_until_parked();
    draw(&mut v);
    let title_bar = bounds(&mut v, "thread-header");
    let picker = bounds(&mut v, "composer-picker");
    let inside = |b: Bounds<gpui::Pixels>| b.top() >= picker.top() && b.bottom() <= picker.bottom();
    assert!(
        picker.top() >= title_bar.bottom(),
        "the picker's top stays below the title bar: {picker:?} under {title_bar:?}"
    );
    assert!(
        picker.size.height < px(MODEL_HEIGHT),
        "the picker is clamped: {picker:?}"
    );
    for id in [
        "composer-model-heading",
        "lead-house-favorites",
        "composer-model-input",
    ] {
        let b = bounds(&mut v, id);
        assert!(
            inside(b),
            "{id} stays inside the picker: {b:?} in {picker:?}"
        );
    }
}
