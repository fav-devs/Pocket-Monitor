//! The 100 Hz input thread (`docs/desktop-expo-port.md` §3.3 rule 3, P7).
//!
//! It owns the gimbal stick stream ([`GimbalDrive`]): the web posts throws and a
//! heartbeat through `gimbal_drive`, and this thread decides what reaches the wire and
//! when — the 200 ms keepalive, the 25 Hz ramp, the immediate rest on release, and the
//! rest after 250 ms of heartbeat silence (a hung or reloaded web view). It also fires the
//! delayed halves of command plans (the tap-focus hint and commit). Nothing here waits on
//! the web view or the window; commands go onto the camera thread's channel.

use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use opc_camera::Command;
use pm_controller::gimbal::{DriveSource, GimbalDrive, StickSend, INPUT_TICK_SECONDS};
use pm_controller::link::{log_line, LinkCommander};

enum InputMsg {
    Drive {
        x: f64,
        y: f64,
        source: DriveSource,
    },
    Release(Option<DriveSource>),
    /// Cancel, focus loss, window close: no ease.
    Rest(&'static str),
    Later {
        delay: f64,
        commands: Vec<Command>,
    },
    Stop,
}

/// A handle on the input thread.
#[derive(Debug)]
pub struct Input {
    tx: Sender<InputMsg>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Input {
    pub fn start(commander: Arc<Mutex<Option<LinkCommander>>>, sensitivity: u8, tau: f64) -> Self {
        let (tx, rx) = channel::<InputMsg>();
        let thread = std::thread::Builder::new()
            .name("pm-input".to_string())
            .spawn(move || {
                let started = Instant::now();
                let now = || started.elapsed().as_secs_f64();
                let mut drive = GimbalDrive::new(sensitivity, tau);
                let mut later: Vec<(f64, Vec<Command>)> = Vec::new();
                let mut summary = (now(), 0u32);
                let send = |command: Command| {
                    if let Ok(slot) = commander.lock() {
                        if let Some(commander) = slot.as_ref() {
                            commander.send(command);
                        }
                    }
                };
                let stick = |sent: Option<StickSend>, at: f64, summary: &mut (f64, u32)| {
                    let Some(sent) = sent else { return };
                    send(sent.command);
                    summary.1 += 1;
                    if sent.rest {
                        // §4.1: every rest is logged, the rest as a 1 Hz summary.
                        log_line(
                            "link",
                            format_args!("stick tx t={:.0} axes=0,0 rest=true", at * 1e6),
                        );
                    }
                };
                loop {
                    let message = match rx.recv_timeout(Duration::from_secs_f64(INPUT_TICK_SECONDS))
                    {
                        Ok(message) => Some(message),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => return,
                    };
                    let at = now();
                    match message {
                        Some(InputMsg::Stop) => return,
                        Some(InputMsg::Drive { x, y, source }) => {
                            stick(drive.drive(x, y, source, at), at, &mut summary)
                        }
                        Some(InputMsg::Release(source)) => {
                            stick(drive.release(source, at), at, &mut summary)
                        }
                        Some(InputMsg::Rest(why)) => {
                            if !drive.is_resting() {
                                log_line("input", format_args!("rest: {why}"));
                                stick(Some(drive.rest_now(at)), at, &mut summary);
                            }
                        }
                        Some(InputMsg::Later { delay, commands }) => {
                            later.push((at + delay, commands));
                        }
                        None => {}
                    }
                    stick(drive.tick(at), at, &mut summary);
                    let mut index = 0;
                    while index < later.len() {
                        if later[index].0 <= at {
                            for command in later.swap_remove(index).1 {
                                send(command);
                            }
                        } else {
                            index += 1;
                        }
                    }
                    if at - summary.0 >= 1.0 {
                        if summary.1 > 0 {
                            let (x, y) = drive.sent();
                            log_line(
                                "link",
                                format_args!(
                                    "stick tx t={:.0} sends={} axes={x:.2},{y:.2} rest={}",
                                    at * 1e6,
                                    summary.1,
                                    drive.is_resting()
                                ),
                            );
                        }
                        summary = (at, 0);
                    }
                }
            })
            .ok();
        Self {
            tx,
            thread: Mutex::new(thread),
        }
    }

    pub fn drive(&self, x: f64, y: f64, source: DriveSource) {
        let _ = self.tx.send(InputMsg::Drive { x, y, source });
    }

    pub fn release(&self, source: Option<DriveSource>) {
        let _ = self.tx.send(InputMsg::Release(source));
    }

    pub fn rest(&self, why: &'static str) {
        let _ = self.tx.send(InputMsg::Rest(why));
    }

    pub fn later(&self, delay: f64, commands: Vec<Command>) {
        let _ = self.tx.send(InputMsg::Later { delay, commands });
    }

    pub fn stop(&self) {
        let _ = self.tx.send(InputMsg::Stop);
        if let Some(thread) = self.thread.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = thread.join();
        }
    }
}
