use super::*;
use std::{net::TcpListener, thread, time::Duration};

// Small sealed-contract fixture: the content is opaque and can speak only to
// its trusted parent relay. No display-dependent test substitutes for WebKit.
fn sealed(nonce: &str, probe: &str) -> String {
    let content = format!(
        r#"<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
        <style>body{{margin:0}}#chart{{height:176px;background:#85aaff}}</style><div id="chart">Snapshot fixture</div><script>
        const nonce = {nonce}; const probe = {probe}; let theme; let saved;
        let parentDenied=false; try{{parent.document.body}}catch{{parentDenied=true}}
        const handlerHidden=!window.webkit?.messageHandlers?.o8Visualization;
        let popupDenied=false; try{{popupDenied=window.open(probe)===null}}catch{{popupDenied=true}}
        fetch(probe).catch(()=>{{}}); new Image().src=probe;
        fetch('file:///etc/passwd').catch(()=>{{}});
        location.href='about:blank';
        function post(type, data){{parent.postMessage({{type:'o8-visualization:'+type,nonce,...data}},'*')}}
        post('height',{{height:176}});
        addEventListener('message', event => {{
          if(event.source!==parent || event.data?.nonce!==nonce)return;
          if(event.data.type==='o8-visualization:theme')theme=event.data.theme.colorScheme;
          if(event.data.type==='o8-visualization:state')saved=event.data.value;
          if(theme && saved){{
            document.querySelector('#chart').style.background=theme==='light'?'#e4ebfa':'#253656';
            document.querySelector('#chart').textContent=saved.selected+' / '+theme;
            post('state',{{value:{{selected:saved.selected,theme,width:innerWidth,parentDenied,handlerHidden,popupDenied}}}});
          }}
        }});
        </script>"#,
        nonce = json!(nonce),
        probe = json!(probe)
    );
    format!(
        r#"<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'">
        <style>html,body{{margin:0;width:100%;height:100%;overflow:hidden}}iframe{{width:100%;height:100%;border:0}}</style>
        <iframe sandbox="allow-scripts"></iframe><script>
        const frame=document.querySelector('iframe'); frame.srcdoc={content};
        addEventListener('message', event=>{{
          if(event.data?.nonce!=={nonce})return;
          if(event.source===frame.contentWindow)dispatchEvent(new CustomEvent('o8:native-visualization-message',{{detail:event.data}}));
          else if(event.source===window)frame.contentWindow.postMessage(event.data,'*');
        }});</script>"#,
        content = json!(content).to_string().replace('<', "\\u003c"),
        nonce = json!(nonce)
    )
}

#[gpui::test]
fn linux_visualizations_card_reaches_ready_with_renderer_picture(cx: &mut gpui::TestAppContext) {
    if std::env::var_os("DISPLAY").is_none() {
        eprintln!("SKIP Linux visualization renderer: DISPLAY is unset; run under xvfb-run.");
        return;
    }
    if !std::process::Command::new("pkg-config")
        .args(["--exists", "webkit2gtk-4.1"])
        .status()
        .is_ok_and(|status| status.success())
    {
        eprintln!("SKIP Linux visualization renderer: WebKitGTK 4.1 is missing.");
        return;
    }
    let binary = std::env::var_os("O8_NEXT_NATIVE_BINARY")
        .expect("set O8_NEXT_NATIVE_BINARY to the built o8-next binary");
    assert!(
        std::path::Path::new(&binary).is_file(),
        "build the real helper binary first"
    );
    let probe = TcpListener::bind("127.0.0.1:0").unwrap();
    probe.set_nonblocking(true).unwrap();
    let probe_url = format!("http://{}/forbidden", probe.local_addr().unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let client =
        Client::authenticated(&format!("http://{}", listener.local_addr().unwrap()), None).unwrap();
    let reference = Reference::parse(&json!({"kind":"o8-visualization",
        "id":"vis-00000000-0000-0000-0000-000000005274", "title":"Renderer fixture",
        "height":320,"createdAt":"2026-11-04T00:00:00Z"}))
    .unwrap();
    let returned = reference.clone();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "card must fetch its sealed document"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("{error}"),
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = [0u8; 4096];
        let count = socket.read(&mut bytes).unwrap();
        let request = String::from_utf8_lossy(&bytes[..count]);
        let target = request.split_whitespace().nth(1).unwrap();
        let url = url::Url::parse(&format!("http://localhost{target}")).unwrap();
        assert_eq!(url.path(), format!("/api/visualizations/{}", returned.id));
        let nonce = url
            .query_pairs()
            .find(|(key, _)| key == "nativeNonce")
            .unwrap()
            .1
            .into_owned();
        let body =
            json!({"result":{"visualization":returned,"sealedHtml":sealed(&nonce, &probe_url)}})
                .to_string();
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    });
    let directory = std::env::temp_dir().join(format!("o8-5274-state-{}", std::process::id()));
    let state_file = directory.join("view.json");
    save_state(&state_file, &json!({"selected":"Week 2"}));
    let mut card = Card::new(reference, client);
    card.state = read_state(&state_file);
    card.state_file = Some(state_file.clone());
    let card = Rc::new(RefCell::new(card));
    let _lease = Lease::new(vec![card.clone()]);
    let window = cx.add_empty_window();
    let bounds = gpui::Bounds::new(
        gpui::point(gpui::px(0.), gpui::px(0.)),
        gpui::size(gpui::px(728.), gpui::px(320.)),
    );
    window.update(|window, _| card.borrow_mut().paint(bounds, bounds, window));
    wait(&card);
    server.join().unwrap();
    assert_eq!(card.borrow().height, 176.);
    assert!(card.borrow().snapshot.picture.is_some());
    assert_eq!(read_state(&state_file)["selected"], "Week 2");
    for key in ["parentDenied", "handlerHidden", "popupDenied"] {
        assert_eq!(read_state(&state_file)[key], true, "{key}");
    }
    assert_eq!(read_state(&state_file)["width"], 728);
    let first = card.borrow().snapshot.picture.clone().unwrap();
    let mut theme = crate::theme::visualization();
    theme["colorScheme"] = json!(if theme["colorScheme"] == "dark" {
        "light"
    } else {
        "dark"
    });
    card.borrow_mut()
        .prepare_picture(360., theme.clone(), Instant::now() - Duration::from_secs(1));
    // A second change while the helper is running must have just one successor.
    card.borrow_mut()
        .prepare_picture(480., theme.clone(), Instant::now() - Duration::from_secs(1));
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        card.borrow_mut().poll();
        if read_state(&state_file)["width"] == 480 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "latest width did not render: {:?}",
            card.borrow().error
        );
        assert!(card.borrow().error.is_none(), "{:?}", card.borrow().error);
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(read_state(&state_file)["theme"], theme["colorScheme"]);
    assert!(!std::sync::Arc::ptr_eq(
        &first,
        card.borrow().snapshot.picture.as_ref().unwrap()
    ));
    assert!(
        matches!(probe.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "the document must make no remote requests"
    );
    std::fs::remove_file(state_file).unwrap();
    std::fs::remove_dir(directory).unwrap();
    eprintln!(
        "PASS Linux visualization card: real helper, PNG, height, saved state, theme and coalesced width refresh."
    );
}
fn wait(card: &Rc<RefCell<Card>>) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        card.borrow_mut().poll();
        assert!(
            card.borrow().error.is_none(),
            "renderer error: {:?}",
            card.borrow().error
        );
        if card.borrow().ready {
            return;
        }
        assert!(Instant::now() < deadline, "card did not become ready");
        thread::sleep(Duration::from_millis(10));
    }
}
