use super::Composer;
use gpui::{
    AppContext, Context, Entity, IntoElement, Modifiers, ParentElement, Render, Styled,
    TestAppContext, VisualTestContext, Window, div,
};
use serde_json::json;
use std::path::PathBuf;

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAFAAAAAwCAIAAAAJh2qgAAAAVklEQVR4nO3PAQ3AIADAMEAOnlCOmbv4k71VsM197viT9XXA2wzXGa4zXGe4znCd4TrDdYbrDNcZrjNcZ7jOcJ3hOsN1husM1xmuM1xnuM5wneE6w3UPI0QBwum7oOkAAAAASUVORK5CYII=";

/// The thread composer as the chat card hosts it: the input, then Drafts.
struct Host(Entity<Composer>);
impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(self.0.clone())
            .children(self.0.update(cx, |i, cx| i.stash_chip(cx)))
    }
}
fn store(name: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!(
            "o8-{name}-{}-{}",
            std::process::id(),
            crate::clock::now()
        ))
        .join("thread.json")
}
/// Opens a thread composer the way the chat surface does: its saved drafts
/// load from the thread's store.
fn open(
    cx: &mut TestAppContext,
    path: Option<PathBuf>,
) -> (Entity<Composer>, &mut VisualTestContext) {
    let (host, cx) = cx.add_window_view(|window, cx| {
        let composer = cx.new(|cx| {
            let mut composer = Composer::new(cx);
            composer.send_intents = true;
            composer.controls.prompt.store = path;
            composer.load_stash(cx);
            composer
        });
        composer.read(cx).focus.focus(window);
        Host(composer)
    });
    cx.run_until_parked();
    let composer = host.read_with(cx, |h, _| h.0.clone());
    (composer, cx)
}
fn draw(cx: &mut VisualTestContext) {
    for _ in 0..2 {
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
    }
}
fn type_draft(text: &str, cx: &mut VisualTestContext) {
    cx.simulate_keystrokes("secondary-a backspace");
    cx.simulate_input(text);
}
fn stash(cx: &mut VisualTestContext) {
    cx.simulate_keystrokes("secondary-s");
    cx.run_until_parked();
    draw(cx);
}
fn click(selector: &'static str, cx: &mut VisualTestContext) {
    draw(cx);
    let bounds = cx.debug_bounds(selector).expect(selector);
    cx.simulate_click(bounds.center(), Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}
fn texts(composer: &Entity<Composer>, cx: &VisualTestContext) -> Vec<String> {
    composer.read_with(cx, |i, _| {
        i.controls.stash.iter().map(|d| d.text.clone()).collect()
    })
}

#[gpui::test]
fn native_drafts_stash_and_restore_keep_an_image_and_a_file(cx: &mut TestAppContext) {
    let (composer, cx) = open(cx, None);
    let image = json!({"name":"kept.png", "dataUri":format!("data:image/png;base64,{PNG}")});
    let file = PathBuf::from("/tmp/clip.mov");
    type_draft("Keep this", cx);
    composer.update(cx, |i, cx| {
        i.controls.images.push(image.clone());
        i.controls.files.push(file.clone());
        cx.notify();
    });
    stash(cx);
    composer.read_with(cx, |i, _| {
        assert_eq!(i.text, "");
        assert!(i.controls.images.is_empty() && i.controls.files.is_empty());
    });
    assert_eq!(texts(&composer, cx), ["Keep this"]);
    click("composer-drafts", cx);
    click("composer-draft-0", cx);
    composer.read_with(cx, |i, _| {
        assert_eq!(i.text, "Keep this");
        assert_eq!(i.controls.images, vec![image.clone()]);
        assert_eq!(i.controls.files, vec![file.clone()]);
        assert!(i.controls.stash.is_empty() && !i.controls.stash_open);
        assert!(
            i.controls
                .previews
                .contains_key(image["dataUri"].as_str().unwrap()),
            "a restored image gets its thumbnail back"
        );
    });
}

#[gpui::test]
fn native_drafts_restore_into_a_typed_composer_stashes_it_first(cx: &mut TestAppContext) {
    let (composer, cx) = open(cx, None);
    type_draft("First idea", cx);
    stash(cx);
    type_draft("Second idea", cx);
    click("composer-drafts", cx);
    click("composer-draft-0", cx);
    composer.read_with(cx, |i, _| assert_eq!(i.text, "First idea"));
    assert_eq!(texts(&composer, cx), ["Second idea"]);
}

#[gpui::test]
fn native_drafts_delete_one_and_keep_the_rest(cx: &mut TestAppContext) {
    let (composer, cx) = open(cx, None);
    type_draft("Old", cx);
    stash(cx);
    type_draft("New", cx);
    stash(cx);
    click("composer-drafts", cx);
    click("composer-draft-delete-0", cx);
    assert_eq!(texts(&composer, cx), ["New"]);
    composer.read_with(cx, |i, _| assert_eq!(i.text, ""));
    click("composer-draft-delete-0", cx);
    assert!(texts(&composer, cx).is_empty());
    assert!(cx.debug_bounds("composer-drafts").is_none());
}

#[gpui::test]
fn native_drafts_survive_reopening_the_thread(app: &mut TestAppContext) {
    let path = store("stash-store");
    let file = PathBuf::from("/tmp/notes.log");
    let (composer, cx) = open(app, Some(path.clone()));
    type_draft("Survives restart", cx);
    composer.update(cx, |i, _| i.controls.files.push(file.clone()));
    stash(cx);
    type_draft("Second", cx);
    stash(cx);
    assert!(path.with_extension("stash.json").exists());
    cx.update(|window, _| window.remove_window());
    drop(composer);
    let (reopened, cx) = open(app, Some(path.clone()));
    assert_eq!(texts(&reopened, cx), ["Survives restart", "Second"]);
    reopened.read_with(cx, |i, _| {
        assert_eq!(i.controls.stash[0].files, vec![file.clone()])
    });
    click("composer-drafts", cx);
    click("composer-draft-delete-1", cx);
    cx.update(|window, _| window.remove_window());
    drop(reopened);
    let (again, cx) = open(app, Some(path.clone()));
    assert_eq!(texts(&again, cx), ["Survives restart"]);
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[gpui::test]
fn native_drafts_ignore_cmd_s_on_an_empty_composer(cx: &mut TestAppContext) {
    let path = store("stash-empty");
    let (composer, cx) = open(cx, Some(path.clone()));
    type_draft("   ", cx);
    stash(cx);
    assert!(texts(&composer, cx).is_empty());
    composer.read_with(cx, |i, _| assert_eq!(i.text, "   "));
    assert!(cx.debug_bounds("composer-drafts").is_none());
    assert!(!path.with_extension("stash.json").exists());
}
