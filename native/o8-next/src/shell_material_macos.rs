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

/// Marks the backdrop this file adds, so a later switch removes only it.
const IDENTIFIER: &str = "o8-next-glass";

fn content_view(window: &gpui::Window) -> Option<id> {
    let handle = HasWindowHandle::window_handle(window).ok()?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return None;
    };
    Some(handle.ns_view.as_ptr() as id)
}

fn identifier() -> id {
    unsafe {
        let name = <id as cocoa::foundation::NSString>::init_str(
            cocoa::foundation::NSString::alloc(nil),
            IDENTIFIER,
        );
        let _: id = msg_send![name, autorelease];
        name
    }
}

/// Removes the backdrop `install` added, when an opaque appearance replaces it.
pub(super) fn remove(window: &gpui::Window) {
    let Some(content) = content_view(window) else {
        return;
    };
    // UI thread, native window alive; removing releases the parent's retain.
    unsafe {
        let parent = NSView::superview(content);
        if parent == nil {
            return;
        }
        let subviews: id = msg_send![parent, subviews];
        let count: usize = msg_send![subviews, count];
        let mine = identifier();
        let mut marked = Vec::new();
        for index in 0..count {
            let view: id = msg_send![subviews, objectAtIndex: index];
            let name: id = msg_send![view, identifier];
            let same: cocoa::base::BOOL = msg_send![name, isEqualToString: mine];
            if name != nil && same != cocoa::base::NO {
                marked.push(view);
            }
        }
        for view in marked {
            let _: () = msg_send![view, removeFromSuperview];
        }
    }
}

pub(super) fn install(window: &gpui::Window) -> bool {
    let Some(content) = content_view(window) else {
        return false;
    };
    // This is called on the UI thread while the native window is alive.
    // addSubview retains the effect; its parent releases it at window teardown.
    unsafe {
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
        NSVisualEffectView::setMaterial_(effect, material());
        NSVisualEffectView::setBlendingMode_(effect, NSVisualEffectBlendingMode::BehindWindow);
        // All Glass is a dark material; keep it dark when the system is in light mode.
        let name = <id as cocoa::foundation::NSString>::init_str(
            cocoa::foundation::NSString::alloc(nil),
            "NSAppearanceNameDarkAqua",
        );
        let appearance: id = msg_send![class!(NSAppearance), appearanceNamed: name];
        let _: () = msg_send![effect, setAppearance: appearance];
        let _: () = msg_send![name, release];
        NSVisualEffectView::setState_(effect, NSVisualEffectState::Active);
        NSView::setAutoresizingMask_(effect, NSViewWidthSizable | NSViewHeightSizable);
        let _: () = msg_send![effect, setIdentifier: identifier()];
        let _: () = msg_send![parent, addSubview:effect positioned:NSWindowOrderingMode::NSWindowBelow relativeTo:content];
        let _: () = msg_send![effect, release];
    }
    true
}

// chrome_vibrancy_material in src-tauri/src/lib.rs (#1543): HudWindow stopped
// rendering behind windows on macOS 15.7.8 and 26.x, where UnderWindowBackground
// is the verified replacement.
fn material() -> NSVisualEffectMaterial {
    let mut buffer = [0u8; 32];
    let mut length = buffer.len();
    // SAFETY: the name is NUL-terminated and the buffer length is passed in and out.
    let found = unsafe {
        sysctlbyname(
            b"kern.osproductversion\0".as_ptr().cast(),
            buffer.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    } == 0;
    let version = found
        .then(|| std::str::from_utf8(&buffer[..length.saturating_sub(1)]).ok())
        .flatten()
        .unwrap_or("");
    let mut parts = version
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0));
    let (major, minor, patch) = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    if major >= 26 || (major == 15 && minor == 7 && patch >= 8) {
        NSVisualEffectMaterial::UnderWindowBackground
    } else {
        NSVisualEffectMaterial::HudWindow
    }
}

// The pinned syntax reader treats macro token trees opaquely (as in
// sidebar/calendar.rs); the compiler still checks the declaration.
macro_rules! system_abi {
    ($($declaration:tt)*) => { unsafe extern "C" { $($declaration)* } };
}
system_abi! {
    fn sysctlbyname(
        name: *const std::ffi::c_char,
        oldp: *mut std::ffi::c_void,
        oldlenp: *mut usize,
        newp: *mut std::ffi::c_void,
        newlen: usize,
    ) -> std::ffi::c_int;
}

pub(super) fn reduced_transparency() -> bool {
    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let reduced: cocoa::base::BOOL =
            msg_send![workspace, accessibilityDisplayShouldReduceTransparency];
        reduced != cocoa::base::NO
    }
}
