//! Settings › Mobile, from classic's Mobile tab: remote access, the pairing
//! code and each paired phone. The code carries this server's token, so it's
//! made only on request and its contents are never written on screen.
use super::providers::call;
use crate::client::Client;
use crate::theme::current as theme;
use gpui::{
    AnyElement, Bounds, Context, IntoElement, Render, SharedString, Window, canvas, div, fill,
    point, prelude::*, px, size,
};
use qrcode::{Color, EcLevel, QrCode};
use serde_json::{Value, json};
use std::time::Duration;

const ATTACH: &str = "/api/panel/connect/attach";
const PAIRING: &str = "/api/panel/mobile-pairing";
const DEVICES: &str = "/api/mobile/devices";
const REVOKE: &str = "/api/mobile/devices/revoke";
const TIMEOUT: Duration = Duration::from_secs(10);
/// An enroll code lasts 5 minutes and works once, so a shown code renews first.
const RENEW: Duration = Duration::from_secs(240);
const QR_SIZE: f32 = 240.;
const QR_MARGIN: usize = 2;
pub(crate) const LAN_OFF: &str = "Phone pairing needs local network access, which is off by \
     default: o8 only listens on 127.0.0.1. Quit o8, relaunch it with O8_LAN_ACCESS=1 in its \
     environment, then retry.";
const NO_ADDRESS: &str = "No local network address found. Connect this Mac to Wi-Fi, then retry.";

#[derive(Clone, Debug, PartialEq)]
struct Code {
    width: usize,
    dark: Vec<bool>,
    hosts: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
enum Pairing {
    Hidden,
    Loading,
    Ready(Code),
    Failed(String),
}

#[derive(Clone, Debug, PartialEq)]
struct Device {
    id: String,
    label: String,
    line: String,
    revoked: bool,
}

/// A code is up only while its page is: anywhere else it would keep minting
/// single-use enroll codes, and be waiting on screen when the page came back.
pub(crate) fn page_shown(section: &str, query: &str) -> bool {
    section == "mobile" && query.len() < 2
}

/// The JSON the o8 app's scanner reads, built as classic builds it.
fn payload(reply: &Value, hosts: &[String]) -> Value {
    let mut body = json!({
        "v": reply["v"],
        "host": reply["host"],
        "hosts": hosts,
        "apiPort": reply["apiPort"],
        "wsPort": reply["wsPort"],
        "token": reply["token"],
    });
    for key in ["enroll", "sIdent"] {
        if !reply[key].is_null() {
            body[key] = reply[key].clone();
        }
    }
    body
}

fn pairing_code(reply: &Value) -> Result<Code, String> {
    if reply["lanAccess"] == false {
        return Err(LAN_OFF.into());
    }
    let host = reply["host"].as_str().ok_or(NO_ADDRESS)?;
    let mut hosts: Vec<String> = reply["hosts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|host| host.as_str().map(str::to_owned))
        .collect();
    if hosts.is_empty() {
        hosts.push(host.to_owned());
    }
    let text = payload(reply, &hosts).to_string();
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M)
        .map_err(|_| "Could not make a pairing code.".to_owned())?;
    Ok(Code {
        width: code.width(),
        dark: code
            .to_colors()
            .into_iter()
            .map(|color| color == Color::Dark)
            .collect(),
        hosts,
    })
}

/// sqlite's datetime('now') is UTC with a space and no zone.
fn relative(value: &Value) -> String {
    let age = value
        .as_str()
        .and_then(|value| crate::clock::timestamp(&format!("{}Z", value.replace(' ', "T"))))
        .map(|time| crate::clock::age(Some(time), crate::clock::now()));
    match age.as_deref() {
        None => "unknown".into(),
        Some("now") => "just now".into(),
        Some(age) => format!("{age} ago"),
    }
}

fn devices(reply: &Value) -> Vec<Device> {
    reply["devices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|device| {
            let revoked = !device["revokedAt"].is_null();
            let paired = relative(&device["createdAt"]);
            Some(Device {
                id: device["id"].as_str()?.to_owned(),
                label: device["deviceLabel"]
                    .as_str()
                    .map(str::trim)
                    .filter(|label| !label.is_empty())
                    .map_or("Unnamed device".into(), crate::text::sanitize),
                line: if revoked {
                    format!(
                        "Revoked {} · paired {paired}",
                        relative(&device["revokedAt"])
                    )
                } else {
                    format!(
                        "Paired {paired} · last seen {}",
                        relative(&device["lastSeenAt"])
                    )
                },
                revoked,
            })
        })
        .collect()
}

pub(crate) struct Mobile {
    client: Client,
    started: bool,
    connect: Option<bool>,
    connect_locked: bool,
    connect_saving: bool,
    connect_error: Option<String>,
    pairing: Pairing,
    pairing_turn: u64,
    devices: Option<Vec<Device>>,
    devices_error: Option<String>,
    confirming: Option<String>,
    revoking: Option<String>,
}

impl Mobile {
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let _ = cx;
        // Nothing is read until the page is first shown.
        Self {
            client,
            started: false,
            connect: None,
            connect_locked: false,
            connect_saving: false,
            connect_error: None,
            pairing: Pairing::Hidden,
            pairing_turn: 0,
            devices: None,
            devices_error: None,
            confirming: None,
            revoking: None,
        }
    }

    fn start(&mut self, cx: &mut Context<Self>) {
        self.started = true;
        self.load_devices(cx);
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { call::<Value>(&client, "GET", ATTACH, json!({}), TIMEOUT) });
        cx.spawn(async move |this, cx| {
            let reply = task.await;
            let _ = this.update(cx, |this, cx| {
                this.read_attach(reply);
                cx.notify();
            });
        })
        .detach();
    }

    fn read_attach(&mut self, reply: Result<Value, String>) {
        match reply {
            Ok(reply) if reply["ok"] == true && reply["enabled"].is_boolean() => {
                self.connect = reply["enabled"].as_bool();
                self.connect_locked = reply["locked"] == true;
                self.connect_error = None;
            }
            Ok(reply) => {
                self.connect_error = Some(
                    reply["error"]["message"]
                        .as_str()
                        .unwrap_or("Could not read the connect setting.")
                        .to_owned(),
                );
            }
            Err(error) => self.connect_error = Some(error),
        }
    }

    fn set_connect(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.connect_saving {
            return;
        }
        self.connect_saving = true;
        self.connect_error = None;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            call::<Value>(
                &client,
                "POST",
                ATTACH,
                json!({ "enabled": enabled }),
                TIMEOUT,
            )
        });
        cx.spawn(async move |this, cx| {
            let reply = task.await;
            let _ = this.update(cx, |this, cx| {
                this.connect_saving = false;
                this.read_attach(reply);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Makes a fresh code, and keeps renewing it for as long as it's shown.
    pub(crate) fn show_pairing(&mut self, cx: &mut Context<Self>) {
        self.pairing_turn += 1;
        let turn = self.pairing_turn;
        self.pairing = Pairing::Loading;
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            loop {
                let reader = client.clone();
                let code = cx
                    .background_executor()
                    .spawn(async move {
                        call::<Value>(&reader, "GET", PAIRING, json!({}), TIMEOUT)
                            .and_then(|reply| pairing_code(&reply))
                    })
                    .await;
                let shown = this.update(cx, |this, cx| {
                    if this.pairing_turn != turn {
                        return false;
                    }
                    let ready = code.is_ok();
                    match code {
                        Ok(code) => this.pairing = Pairing::Ready(code),
                        // A failed renewal must not leave a spent code up.
                        Err(error) => this.pairing = Pairing::Failed(error),
                    }
                    cx.notify();
                    ready
                });
                if !matches!(shown, Ok(true)) {
                    return;
                }
                cx.background_executor().timer(RENEW).await;
            }
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn hide_pairing(&mut self, cx: &mut Context<Self>) {
        if self.pairing == Pairing::Hidden {
            return;
        }
        self.pairing_turn += 1;
        self.pairing = Pairing::Hidden;
        cx.notify();
    }

    fn load_devices(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { call::<Value>(&client, "GET", DEVICES, json!({}), TIMEOUT) });
        cx.spawn(async move |this, cx| {
            let reply = task.await;
            let _ = this.update(cx, |this, cx| {
                match reply {
                    Ok(reply) => {
                        this.devices = Some(devices(&reply));
                        this.devices_error = None;
                    }
                    Err(error) => {
                        this.devices.get_or_insert_with(Vec::new);
                        this.devices_error = Some(error);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn revoke(&mut self, id: String, cx: &mut Context<Self>) {
        if self.revoking.is_some() {
            return;
        }
        self.revoking = Some(id.clone());
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            call::<Value>(&client, "POST", REVOKE, json!({ "deviceId": id }), TIMEOUT)
        });
        cx.spawn(async move |this, cx| {
            let reply = task.await;
            let _ = this.update(cx, |this, cx| {
                this.revoking = None;
                this.confirming = None;
                if let Err(error) = reply {
                    this.devices_error = Some(error);
                }
                this.load_devices(cx);
            });
        })
        .detach();
        cx.notify();
    }

    fn button(
        &self,
        id: String,
        label: &'static str,
        enabled: bool,
        cx: &mut Context<Self>,
        run: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        let selector = id.clone();
        div()
            .id(SharedString::from(id))
            .debug_selector(move || selector.clone())
            .flex_none()
            .px(px(8.))
            .py(px(2.))
            .rounded(px(6.))
            .text_size(px(11.))
            .border_1()
            .border_color(theme().border)
            .when(!enabled, |v| v.opacity(0.45))
            .when(enabled, |v| {
                v.cursor_pointer()
                    .hover(|v| v.bg(theme().hover))
                    .on_click(cx.listener(move |this, _, _, cx| run(this, cx)))
            })
            .child(label)
    }

    fn device_row(&self, device: &Device, cx: &mut Context<Self>) -> AnyElement {
        let confirming = self.confirming.as_deref() == Some(device.id.as_str());
        let free = self.revoking.is_none();
        let id = device.id.clone();
        let (first, second) = (id.clone(), id.clone());
        row(device.label.clone(), device.line.clone())
            .when(device.revoked, |v| v.child(muted("Revoked".into())))
            .when(!device.revoked && !confirming, |v| {
                v.child(self.button(
                    format!("settings-mobile-revoke-{id}"),
                    "Revoke",
                    free,
                    cx,
                    move |this, cx| {
                        this.confirming = Some(first.clone());
                        cx.notify();
                    },
                ))
            })
            .when(!device.revoked && confirming, |v| {
                v.child(muted("Revoke this device?".into()))
                    .child(self.button(
                        format!("settings-mobile-revoke-yes-{id}"),
                        "Revoke",
                        free,
                        cx,
                        move |this, cx| this.revoke(second.clone(), cx),
                    ))
                    .child(self.button(
                        format!("settings-mobile-revoke-no-{id}"),
                        "Cancel",
                        free,
                        cx,
                        |this, cx| {
                            this.confirming = None;
                            cx.notify();
                        },
                    ))
            })
            .into_any_element()
    }
}

fn muted(text: String) -> gpui::Div {
    div()
        .text_size(px(11.))
        .text_color(theme().text_muted)
        .child(text)
}

fn row(title: String, line: String) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .p(px(10.))
        .rounded(px(10.))
        .border_1()
        .border_color(theme().border)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(div().text_size(px(13.)).child(title))
                .child(muted(line)),
        )
}

/// The code is black on white whatever the theme, with the margin scanners need.
fn code_view(code: &Code) -> impl IntoElement {
    let code = code.clone();
    canvas(
        |_, _, _| (),
        move |bounds: Bounds<gpui::Pixels>, _, window, _| {
            window.paint_quad(fill(bounds, gpui::white()));
            let cells = code.width + QR_MARGIN * 2;
            let cell = (f32::from(bounds.size.width) / cells as f32)
                .floor()
                .max(1.);
            let used = cell * cells as f32;
            let left = f32::from(bounds.origin.x)
                + (f32::from(bounds.size.width) - used) / 2.
                + cell * QR_MARGIN as f32;
            let top = f32::from(bounds.origin.y)
                + (f32::from(bounds.size.height) - used) / 2.
                + cell * QR_MARGIN as f32;
            for (index, _) in code.dark.iter().enumerate().filter(|(_, dark)| **dark) {
                let (x, y) = (index % code.width, index / code.width);
                window.paint_quad(fill(
                    Bounds::new(
                        point(px(left + x as f32 * cell), px(top + y as f32 * cell)),
                        size(px(cell), px(cell)),
                    ),
                    gpui::black(),
                ));
            }
        },
    )
    .size(px(QR_SIZE))
}

impl Render for Mobile {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.started {
            self.start(cx);
        }
        let connect = self.connect;
        let can_connect = connect.is_some() && !self.connect_saving && !self.connect_locked;
        let connect_note = self.connect_error.clone().unwrap_or_else(|| {
            if self.connect_locked {
                "This switch is controlled by O8_CONNECT_ATTACH.".into()
            } else {
                "Off by default. Run o8 connect first, then turn this on when you want the web \
                 control surface to reach this Mac."
                    .into()
            }
        });
        let pairing_on = self.pairing != Pairing::Hidden;
        let pairing: Option<AnyElement> = match &self.pairing {
            Pairing::Hidden => None,
            Pairing::Loading => Some(muted("Making a pairing code...".into()).into_any_element()),
            Pairing::Failed(error) => Some(muted(error.clone()).into_any_element()),
            Pairing::Ready(code) => Some(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(code_view(code))
                    .child(muted(format!("Reachable at {}", code.hosts.join(", "))))
                    .into_any_element(),
            ),
        };
        let list: Vec<AnyElement> = self
            .devices
            .clone()
            .unwrap_or_default()
            .iter()
            .map(|device| self.device_row(device, cx))
            .collect();
        let empty = self.devices.as_ref().map(Vec::len) == Some(0);
        let loading = self.devices.is_none();
        div()
            .id("settings-mobile")
            .debug_selector(|| "settings-mobile".into())
            .flex()
            .flex_col()
            .gap(px(10.))
            .max_w(px(620.))
            .child("Mobile")
            .child(muted(
                "Pair the o8 mobile app to approve, monitor and steer your fleet from your phone."
                    .into(),
            ))
            .child(muted("Remote access".into()))
            .child(
                row(
                    "Connect this Mac".into(),
                    "Keep an authenticated outbound connection to the o8 relay".into(),
                )
                .child(self.button(
                    "settings-mobile-connect".into(),
                    if connect == Some(true) {
                        "Turn off"
                    } else {
                        "Turn on"
                    },
                    can_connect,
                    cx,
                    move |this, cx| this.set_connect(connect != Some(true), cx),
                )),
            )
            .child(muted(connect_note))
            .child(muted("Pairing".into()))
            .child(
                row(
                    "Pairing code".into(),
                    "o8 mobile connects directly to this Mac. Your phone needs the same Wi-Fi, \
                     or Tailscale when you're away."
                        .into(),
                )
                .child(self.button(
                    "settings-mobile-pair".into(),
                    if pairing_on {
                        "Hide"
                    } else {
                        "Show pairing QR"
                    },
                    true,
                    cx,
                    move |this, cx| {
                        if pairing_on {
                            this.hide_pairing(cx);
                        } else {
                            this.show_pairing(cx);
                        }
                    },
                )),
            )
            .children(pairing)
            .child(muted("Paired devices".into()))
            .when(loading, |v| {
                v.child(muted("Loading paired devices...".into()))
            })
            .when(empty, |v| {
                v.child(muted(
                    "No phones paired yet. Show the pairing QR above and scan it with the o8 app."
                        .into(),
                ))
            })
            .children(list)
            .children(self.devices_error.clone().map(muted))
            .child(div().flex().child(self.button(
                "settings-mobile-refresh".into(),
                "Refresh",
                !loading,
                cx,
                |this, cx| this.load_devices(cx),
            )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply() -> Value {
        json!({"v":1,"host":"100.1.2.3","hosts":["100.1.2.3","192.168.1.2"],"apiPort":1,"wsPort":2,
            "lanAccess":true,"token":"secret"})
    }

    #[test]
    fn the_code_carries_every_address_and_the_handshake_when_there_is_one() {
        let plain = payload(&reply(), &["a".into()]);
        assert_eq!(plain["hosts"], json!(["a"]));
        assert!(plain.get("enroll").is_none());
        let mut secured = reply();
        secured["enroll"] = json!("code");
        secured["sIdent"] = json!("key");
        let body = payload(&secured, &["a".into()]);
        assert_eq!(
            (&body["enroll"], &body["sIdent"]),
            (&json!("code"), &json!("key"))
        );
    }

    #[test]
    fn a_server_nobody_can_reach_says_why_instead_of_showing_a_code() {
        let mut closed = reply();
        closed["lanAccess"] = json!(false);
        assert_eq!(pairing_code(&closed), Err(LAN_OFF.into()));
        let mut lost = reply();
        lost["host"] = Value::Null;
        assert_eq!(pairing_code(&lost), Err(NO_ADDRESS.into()));
    }

    #[test]
    fn only_the_mobile_page_keeps_a_code_up() {
        assert!(page_shown("mobile", ""));
        assert!(!page_shown("general", ""));
        assert!(!page_shown("mobile", "search"));
    }

    #[gpui::test]
    fn hiding_ends_the_renewal_and_clears_the_code(cx: &mut gpui::TestAppContext) {
        let client = Client::authenticated("http://127.0.0.1:1", None).unwrap();
        let view = cx.new(|cx| Mobile::new(client, cx));
        view.update(cx, |mobile, cx| {
            mobile.pairing = Pairing::Ready(pairing_code(&reply()).unwrap());
            let turn = mobile.pairing_turn;
            mobile.hide_pairing(cx);
            assert_eq!(mobile.pairing, Pairing::Hidden);
            assert_eq!(
                mobile.pairing_turn,
                turn + 1,
                "the renewal loop sees a new turn"
            );
        });
    }

    #[test]
    fn a_ready_code_is_square_and_keeps_its_hosts() {
        let code = pairing_code(&reply()).unwrap();
        assert_eq!(code.dark.len(), code.width * code.width);
        assert_eq!(code.hosts.len(), 2);
    }

    #[test]
    fn a_device_reads_the_way_classic_words_it() {
        let list = devices(&json!({"devices":[
            {"id":"a","deviceLabel":"  ","createdAt":"2020-01-01 00:00:00","lastSeenAt":null,"revokedAt":null},
            {"id":"b","deviceLabel":"Phone","createdAt":"2020-01-01 00:00:00","revokedAt":"2020-01-02 00:00:00"}
        ]}));
        assert_eq!(list[0].label, "Unnamed device");
        assert!(list[0].line.ends_with("last seen unknown"));
        assert!(list[1].revoked && list[1].line.starts_with("Revoked"));
    }
}
