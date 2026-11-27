//! The front door: what the app opens on. It shows the cameras it knows and whether
//! each one is answering, offers one click to open the viewfinder, and holds the
//! ways in for a new camera, a phone's shared feed, the demo, and the app's own
//! settings. Closing the viewfinder comes back here.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use eframe::egui::{self, Align, FontId, Layout, RichText, Stroke, Vec2};

use crate::connect::{
    accent_button, ghost_button, ACCENT, BG, BORDER, DIM, ERR, SUCCESS, SURFACE, TEXT,
};
use opc_monitor::appsettings::{self, AppSettings};
use opc_monitor::gesture::{Gesture, GestureAction, GestureMap};
use opc_monitor::homewifi::SavedStation;

/// A camera the app remembers.
pub struct Known {
    /// Camera found by address on the operator's own network.
    pub lan: Option<(Ipv4Addr, Option<i32>)>,
    /// A camera put on the home network over Bluetooth.
    pub station: Option<SavedStation>,
    /// A camera's own Wi-Fi, joined by a saved Windows profile.
    pub softap: Option<(String, Option<i32>)>,
}

#[derive(Debug)]
pub enum HomeChoice {
    Quit,
    /// Open the viewfinder on a camera at this address.
    OpenAddress(SocketAddr, Option<i32>),
    /// Look for the camera on the saved home network, then open it.
    OpenStation,
    /// Join the camera's own Wi-Fi, then open it.
    OpenSoftAp,
    /// The Bluetooth pairing flow.
    Setup,
    /// Phones sharing a feed.
    Phones,
    Demo,
}

struct HomeApp {
    known: Known,
    settings: AppSettings,
    /// Whether the remembered LAN camera answers, from a background probe.
    reach: Option<bool>,
    probe: Option<mpsc::Receiver<bool>>,
    address_text: String,
    note: String,
    show_keys: bool,
    outcome: Arc<Mutex<Option<HomeChoice>>>,
}

/// Is something answering the camera's control port at `ip`?
fn reachable(ip: Ipv4Addr) -> bool {
    std::net::TcpStream::connect_timeout(&SocketAddr::from((ip, 7001)), Duration::from_millis(900))
        .is_ok()
}

fn start_probe(ip: Ipv4Addr) -> mpsc::Receiver<bool> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || loop {
        if sender.send(reachable(ip)).is_err() {
            return; // the screen is gone
        }
        thread::sleep(Duration::from_secs(3));
    });
    receiver
}

/// `10.0.0.5`, `10.0.0.5:9004`; the control port is the default.
fn parse_address(text: &str) -> Option<SocketAddr> {
    let text = text.trim();
    if let Ok(address) = text.parse::<SocketAddr>() {
        return Some(address);
    }
    text.parse::<Ipv4Addr>()
        .ok()
        .map(|ip| SocketAddr::from((ip, 9004)))
}

impl HomeApp {
    fn finish(&self, ctx: &egui::Context, choice: HomeChoice) {
        *self.outcome.lock().unwrap() = Some(choice);
        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
    }

    fn card(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui)) {
        egui::Frame::none()
            .fill(SURFACE)
            .stroke(Stroke::new(1.0, BORDER))
            .rounding(egui::Rounding::same(10.0))
            .inner_margin(egui::Margin::same(18.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                add(ui);
            });
        ui.add_space(12.0);
    }

    fn heading(ui: &mut egui::Ui, text: &str) {
        ui.label(
            RichText::new(text.to_uppercase())
                .font(FontId::proportional(11.0))
                .color(DIM),
        );
        ui.add_space(6.0);
    }

    fn camera_cards(&mut self, ui: &mut egui::Ui) -> Option<HomeChoice> {
        let mut choice = None;
        let mut forget_lan = false;
        let mut forget_station = false;

        if let Some((ip, model)) = self.known.lan {
            let up = self.reach;
            Self::card(ui, |ui| {
                ui.horizontal(|ui| {
                    let (colour, label) = match up {
                        Some(true) => (SUCCESS, "Online"),
                        Some(false) => (ERR, "Not answering"),
                        None => (DIM, "Checking\u{2026}"),
                    };
                    let (dot, _) = ui.allocate_exact_size(Vec2::splat(12.0), egui::Sense::hover());
                    ui.painter().circle_filled(dot.center(), 5.0, colour);
                    ui.vertical(|ui| {
                        ui.label(
                            RichText::new(appsettings::model_label(model))
                                .font(FontId::proportional(20.0))
                                .color(TEXT),
                        );
                        ui.label(
                            RichText::new(format!("On your Wi-Fi \u{00b7} {ip} \u{00b7} {label}"))
                                .font(FontId::proportional(13.0))
                                .color(DIM),
                        );
                    });
                });
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    if accent_button(ui, "Open viewfinder").clicked() {
                        choice = Some(HomeChoice::OpenAddress(SocketAddr::from((ip, 9004)), model));
                    }
                    if ghost_button(ui, "Forget").clicked() {
                        forget_lan = true;
                    }
                });
                if up == Some(false) {
                    ui.add_space(8.0);
                    ui.label(
                        RichText::new(
                            "Check the camera is on and on the same Wi-Fi as this PC. \
                             The viewfinder will keep trying to reach it.",
                        )
                        .font(FontId::proportional(12.0))
                        .color(DIM),
                    );
                }
            });
        }

        if let Some(station) = self.known.station.clone() {
            Self::card(ui, |ui| {
                ui.label(
                    RichText::new(appsettings::model_label(station.model_id))
                        .font(FontId::proportional(20.0))
                        .color(TEXT),
                );
                ui.label(
                    RichText::new(format!("On your home network \u{00b7} {}", station.ssid))
                        .font(FontId::proportional(13.0))
                        .color(DIM),
                );
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    if accent_button(ui, "Find and open").clicked() {
                        choice = Some(HomeChoice::OpenStation);
                    }
                    if ghost_button(ui, "Forget").clicked() {
                        forget_station = true;
                    }
                });
            });
        }

        if let Some((ssid, model)) = self.known.softap.clone() {
            Self::card(ui, |ui| {
                ui.label(
                    RichText::new(appsettings::model_label(model))
                        .font(FontId::proportional(20.0))
                        .color(TEXT),
                );
                ui.label(
                    RichText::new(format!("Camera's own Wi-Fi \u{00b7} {ssid}"))
                        .font(FontId::proportional(13.0))
                        .color(DIM),
                );
                ui.add_space(4.0);
                ui.label(
                    RichText::new(
                        "Joining it moves this PC off your home Wi-Fi until you leave. \
                         Use this one for the media library.",
                    )
                    .font(FontId::proportional(12.0))
                    .color(DIM),
                );
                ui.add_space(12.0);
                if accent_button(ui, "Join and open").clicked() {
                    choice = Some(HomeChoice::OpenSoftAp);
                }
            });
        }

        if forget_lan {
            crate::lan_camera::forget();
            self.known.lan = None;
            self.reach = None;
            self.probe = None;
        }
        if forget_station {
            crate::station::forget();
            self.known.station = None;
        }
        choice
    }
}

impl eframe::App for HomeApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Some(probe) = &self.probe {
            for answer in probe.try_iter() {
                self.reach = Some(answer);
            }
        }
        ctx.request_repaint_after(Duration::from_millis(500));

        let mut visuals = egui::Visuals::dark();
        visuals.panel_fill = BG;
        visuals.window_fill = BG;
        visuals.widgets.noninteractive.bg_fill = SURFACE;
        visuals.widgets.inactive.bg_fill = SURFACE;
        visuals.widgets.hovered.bg_fill = egui::Color32::from_rgb(40, 40, 40);
        visuals.widgets.active.bg_fill = ACCENT;
        visuals.widgets.inactive.bg_stroke =
            Stroke::new(1.0, egui::Color32::from_rgb(110, 110, 110));
        visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, ACCENT);
        visuals.selection.bg_fill = ACCENT;
        visuals.selection.stroke = Stroke::new(1.5, egui::Color32::BLACK);
        ctx.set_visuals(visuals);

        let mut choice: Option<HomeChoice> = None;
        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(BG))
            .show(ctx, |ui| {
                egui::ScrollArea::vertical().show(ui, |ui| {
                    let side = ((ui.available_width() - 600.0) / 2.0).max(16.0);
                    ui.horizontal_top(|ui| {
                    ui.add_space(side);
                    ui.vertical(|ui| {
                    ui.set_width(600.0_f32.min(ui.available_width() - side));
                    ui.with_layout(Layout::top_down(Align::Center), |ui| {
                        ui.set_max_width(600.0);
                        ui.add_space(28.0);
                        ui.label(
                            RichText::new("Pocket Monitor")
                                .font(FontId::proportional(30.0))
                                .color(TEXT),
                        );
                        ui.label(
                            RichText::new("Monitor and control your camera")
                                .font(FontId::proportional(13.0))
                                .color(DIM),
                        );
                        ui.add_space(24.0);
                    });
                    ui.vertical(|ui| {
                        ui.set_max_width(600.0);
                        ui.add_space(4.0);
                        let has_camera = self.known.lan.is_some()
                            || self.known.station.is_some()
                            || self.known.softap.is_some();
                        if has_camera {
                            Self::heading(ui, "Your camera");
                            if let Some(picked) = self.camera_cards(ui) {
                                choice = Some(picked);
                            }
                        }

                        Self::heading(ui, if has_camera { "Add another camera" } else { "Get started" });
                        Self::card(ui, |ui| {
                            if !has_camera {
                                ui.label(
                                    RichText::new("No camera yet")
                                        .font(FontId::proportional(18.0))
                                        .color(TEXT),
                                );
                                ui.label(
                                    RichText::new(
                                        "Pair over Bluetooth and the camera joins your home Wi-Fi, \
                                         or type the address of one that already has.",
                                    )
                                    .font(FontId::proportional(13.0))
                                    .color(DIM),
                                );
                                ui.add_space(12.0);
                            }
                            if accent_button(ui, "Pair a camera over Bluetooth").clicked() {
                                choice = Some(HomeChoice::Setup);
                            }
                            ui.add_space(4.0);
                            ui.label(
                                RichText::new(
                                    "This is how the camera is told your Wi-Fi password, so it needs a \
                                     Bluetooth LE adapter in this PC. No luck? Put the camera on your \
                                     Wi-Fi from your phone instead, then connect by address below.",
                                )
                                .font(FontId::proportional(12.0))
                                .color(DIM),
                            );
                            ui.add_space(14.0);
                            ui.label(
                                RichText::new("Or connect by address")
                                    .font(FontId::proportional(13.0))
                                    .color(DIM),
                            );
                            ui.add_space(4.0);
                            ui.horizontal(|ui| {
                                let edit = ui.add(
                                    egui::TextEdit::singleline(&mut self.address_text)
                                        .hint_text("10.0.0.213")
                                        .desired_width(200.0),
                                );
                                let enter =
                                    edit.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                                if ghost_button(ui, "Connect").clicked() || enter {
                                    match parse_address(&self.address_text) {
                                        Some(address) => {
                                            choice = Some(HomeChoice::OpenAddress(address, None));
                                        }
                                        None => {
                                            self.note =
                                                "That isn't an address. Try something like 10.0.0.213."
                                                    .to_string();
                                        }
                                    }
                                }
                            });
                            if !self.note.is_empty() {
                                ui.add_space(4.0);
                                ui.label(RichText::new(&self.note).font(FontId::proportional(12.0)).color(ERR));
                            }
                        });

                        Self::heading(ui, "Other ways in");
                        Self::card(ui, |ui| {
                            ui.horizontal(|ui| {
                                if ghost_button(ui, "Watch a phone's shared feed \u{203a}").clicked() {
                                    choice = Some(HomeChoice::Phones);
                                }
                                ui.add_space(12.0);
                                if ghost_button(ui, "Try the demo \u{203a}").clicked() {
                                    choice = Some(HomeChoice::Demo);
                                }
                            });
                        });

                        Self::heading(ui, "Settings");
                        Self::card(ui, |ui| {
                            let before = self.settings;
                            ui.label(
                                RichText::new(
                                    "Turn gestures on and off in the viewfinder with J; the source is on the Moves sheet (K). \
                                     Swipe to recentre, flip or step presets; hold a fist, palm or fingers. \
                                     Nothing is recorded.",
                                )
                                .font(FontId::proportional(12.0))
                                .color(DIM),
                            );
                            ui.add_space(8.0);
                            ui.checkbox(
                                &mut self.settings.open_camera_at_launch,
                                "Open my camera straight away when the app starts",
                            );
                            ui.add_space(8.0);
                            egui::CollapsingHeader::new(
                                RichText::new("Gesture guide and controls")
                                    .font(FontId::proportional(13.0))
                                    .color(TEXT),
                            )
                            .show(ui, |ui| {
                                ui.label(
                                    RichText::new(
                                        "A hand-tracking model finds your hand and every finger joint, at any \
                                         angle and against any background, on your GPU. Sweeps need a quick, \
                                         clear movement of the palm; poses are held for about a second. \
                                         Press Y in the viewfinder to see what it sees. Choose what each one does:",
                                    )
                                    .font(FontId::proportional(12.0))
                                    .color(DIM),
                                );
                                ui.add_space(6.0);
                                egui::Grid::new("gesture-map")
                                    .num_columns(2)
                                    .spacing([16.0, 10.0])
                                    .show(ui, |ui| {
                                        for gesture in Gesture::ALL {
                                            ui.vertical(|ui| {
                                                ui.label(
                                                    RichText::new(gesture.label())
                                                        .font(FontId::proportional(13.0))
                                                        .color(TEXT),
                                                );
                                                ui.label(
                                                    RichText::new(gesture.how())
                                                        .font(FontId::proportional(11.0))
                                                        .color(DIM),
                                                );
                                            });
                                            let current = self.settings.gesture_map.get(gesture);
                                            egui::ComboBox::from_id_salt(gesture.label())
                                                .selected_text(current.label())
                                                .width(190.0)
                                                .show_ui(ui, |ui| {
                                                    for action in GestureAction::ALL {
                                                        if ui
                                                            .selectable_label(
                                                                current == action,
                                                                action.label(),
                                                            )
                                                            .clicked()
                                                        {
                                                            self.settings
                                                                .gesture_map
                                                                .set(gesture, action);
                                                        }
                                                    }
                                                });
                                            ui.end_row();
                                        }
                                    });
                                ui.add_space(6.0);
                                if ghost_button(ui, "Reset gestures to defaults").clicked() {
                                    self.settings.gesture_map = GestureMap::default();
                                }
                                ui.label(
                                    RichText::new(
                                        "Recording by gesture can fire by accident: give it to a held pose, \
                                         not a swipe. Changes apply the next time the viewfinder opens.",
                                    )
                                    .font(FontId::proportional(11.0))
                                    .color(DIM),
                                );
                            });
                            if self.settings != before {
                                appsettings::save(&self.settings);
                            }
                        });

                        ui.horizontal(|ui| {
                            if ghost_button(
                                ui,
                                if self.show_keys { "Hide shortcuts" } else { "Keyboard shortcuts" },
                            )
                            .clicked()
                            {
                                self.show_keys = !self.show_keys;
                            }
                            ui.label(
                                RichText::new(format!("v{}", env!("CARGO_PKG_VERSION")))
                                    .font(FontId::proportional(11.0))
                                    .color(DIM),
                            );
                        });
                        if self.show_keys {
                            ui.add_space(6.0);
                            ui.label(
                                RichText::new(crate::KEYS)
                                    .font(FontId::monospace(12.0))
                                    .color(DIM),
                            );
                        }
                        ui.add_space(24.0);
                    });
                    });
                    });
                });
            });
        if let Some(choice) = choice {
            self.finish(ctx, choice);
        }
    }
}

/// Shows the home screen and returns what the operator chose.
pub fn run(known: Known) -> HomeChoice {
    let probe = known.lan.map(|(ip, _)| start_probe(ip));
    let outcome: Arc<Mutex<Option<HomeChoice>>> = Arc::new(Mutex::new(None));
    let app = HomeApp {
        known,
        settings: appsettings::load(),
        reach: None,
        probe,
        address_text: String::new(),
        note: String::new(),
        show_keys: false,
        outcome: Arc::clone(&outcome),
    };
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Pocket Monitor")
            .with_inner_size([680.0, 720.0])
            .with_min_inner_size([520.0, 480.0]),
        ..Default::default()
    };
    let _ = eframe::run_native(
        "Pocket Monitor",
        options,
        Box::new(move |_cc| Ok(Box::new(app) as Box<dyn eframe::App>)),
    );
    Arc::try_unwrap(outcome)
        .ok()
        .and_then(|m| m.into_inner().ok())
        .flatten()
        .unwrap_or(HomeChoice::Quit)
}
