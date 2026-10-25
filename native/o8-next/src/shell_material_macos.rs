//! AppKit owns the backdrop and its lifetime with the GPUI content view.
use cocoa::{
    appkit::{
        NSView, NSViewHeightSizable, NSViewWidthSizable, NSVisualEffectBlendingMode,
        NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView, NSWindowOrderingMode,
    },
    base::{id, nil},
};
use objc::{class, msg_send, sel, sel_impl};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

pub(super) fn install(window: &gpui::Window) -> bool {
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return false;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return false;
    };
    // This is called once on the UI thread while the native window is alive.
    // addSubview retains the effect; its parent releases it at window teardown.
    unsafe {
        let content = handle.ns_view.as_ptr() as id;
        // The GPUI content view owns its Metal backing layer. A subview paints
        // above that layer even when ordered below its other subviews.
        let parent = NSView::superview(content);
        if parent == nil {
            return false;
        }
        let frame = NSView::frame(content);
        let effect: id = msg_send![class!(NSVisualEffectView), alloc];
        let effect = NSView::initWithFrame_(effect, frame);
        if effect == nil {
            return false;
        }
        NSVisualEffectView::setMaterial_(effect, NSVisualEffectMaterial::FullScreenUI);
        NSVisualEffectView::setBlendingMode_(effect, NSVisualEffectBlendingMode::BehindWindow);
        NSVisualEffectView::setState_(effect, NSVisualEffectState::Active);
        NSView::setAutoresizingMask_(effect, NSViewWidthSizable | NSViewHeightSizable);
        let _: () = msg_send![parent, addSubview:effect positioned:NSWindowOrderingMode::NSWindowBelow relativeTo:content];
        let _: () = msg_send![effect, release];
    }
    true
}

pub(super) fn reduced_transparency() -> bool {
    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let reduced: cocoa::base::BOOL =
            msg_send![workspace, accessibilityDisplayShouldReduceTransparency];
        reduced != cocoa::base::NO
    }
}
