//! Same public favicon source and loopback fallback as O8BrowserPaneStates.
use gpui::Image;
#[cfg(all(target_os = "macos", not(test)))]
use gpui::ImageFormat;

pub(super) fn host(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    if matches!(
        host,
        "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]" | "::1"
    ) || host.starts_with("10.")
        || host.starts_with("192.168.")
        || (host.starts_with("172.")
            && host
                .split('.')
                .nth(1)
                .and_then(|s| s.parse::<u8>().ok())
                .is_some_and(|n| (16..=31).contains(&n)))
    {
        return None;
    }
    Some(host.into())
}

#[cfg(all(target_os = "macos", not(test)))]
#[allow(unexpected_cfgs)]
pub(super) fn fetch(host: String) -> Option<Image> {
    use cocoa::{
        base::{id, nil},
        foundation::NSString,
    };
    use objc::{class, msg_send, sel, sel_impl};
    let mut url = url::Url::parse("https://www.google.com/s2/favicons").ok()?;
    url.query_pairs_mut()
        .append_pair("domain", &host)
        .append_pair("sz", "32");
    // A bounded, isolated public-image request. No o8 client or website store is used.
    let bytes = objc::rc::autoreleasepool(|| unsafe {
        let text = NSString::alloc(nil).init_str(url.as_str());
        let native_url: id = msg_send![class!(NSURL), URLWithString: text];
        let _: () = msg_send![text, release];
        let configuration: id = msg_send![
            class!(NSURLSessionConfiguration),
            ephemeralSessionConfiguration
        ];
        let _: () = msg_send![configuration, setTimeoutIntervalForRequest: 5.0f64];
        let _: () = msg_send![configuration, setTimeoutIntervalForResource: 5.0f64];
        let session: id = msg_send![class!(NSURLSession), sessionWithConfiguration: configuration];
        let (send, receive) = std::sync::mpsc::channel();
        let completion = block::ConcreteBlock::new(move |data: id, response: id, error: id| {
            let status: isize = msg_send![response, statusCode];
            let length: usize = msg_send![data, length];
            let bytes = if error == nil && status == 200 && (8..=128 * 1024).contains(&length) {
                let bytes: *const u8 = msg_send![data, bytes];
                Some(std::slice::from_raw_parts(bytes, length).to_vec())
            } else {
                None
            };
            let _ = send.send(bytes);
        })
        .copy();
        let task: id =
            msg_send![session, dataTaskWithURL: native_url completionHandler: &*completion];
        let _: () = msg_send![task, resume];
        let bytes = receive
            .recv_timeout(std::time::Duration::from_secs(6))
            .ok()
            .flatten();
        let _: () = msg_send![session, invalidateAndCancel];
        bytes
    })?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    Some(Image::from_bytes(ImageFormat::Png, bytes))
}
#[cfg(any(not(target_os = "macos"), test))]
pub(super) fn fetch(_: String) -> Option<Image> {
    None
}
