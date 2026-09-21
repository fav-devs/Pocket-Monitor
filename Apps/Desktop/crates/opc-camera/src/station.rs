//! Station Wi-Fi: the camera joins a network of the operator's instead of hosting its
//! own, so a laptop can talk to it without leaving the internet.
//!
//! The frames and the reading of every reply come from the core (`MulticamCommands`,
//! `MulticamStationPolicy`, `MulticamJoinPolicy`), observed on hardware. What lives
//! here is the order: identity first, then the role query, the role change and its
//! verification, a settle, then the join with its bounded retries. [`Provisioning`]
//! decides the next step from what the camera said and the clock, and nothing else,
//! so the whole sequence — including the body that has no role getter and the join
//! that has to be asked twice — is testable with no Bluetooth in the room.

use std::ffi::CString;

use opc_core_sys as sys;

use crate::transport::emit;
use crate::CameraError;

/// `0x07/0x39`: ask which Wi-Fi role the camera is in.
pub fn station_wifi_work_mode(seq: u16) -> Result<Vec<u8>, CameraError> {
    emit(|out, capacity| {
        // Safety: the core only writes into `out`.
        unsafe { sys::opc_station_wifi_work_mode(seq, out, capacity) }
    })
}

/// `0x07/0x48`: station role on, or back to the camera's own access point.
pub fn station_mode(enabled: bool, seq: u16) -> Result<Vec<u8>, CameraError> {
    emit(|out, capacity| {
        // Safety: the core only writes into `out`.
        unsafe { sys::opc_station_mode(i32::from(enabled), seq, out, capacity) }
    })
}

/// `0x07/0x47`: join this network.
pub fn station_join(ssid: &str, password: &str, seq: u16) -> Result<Vec<u8>, CameraError> {
    let ssid = CString::new(ssid).map_err(|_| CameraError::InvalidText)?;
    let password = CString::new(password).map_err(|_| CameraError::InvalidText)?;
    emit(|out, capacity| {
        // Safety: both strings outlive the call.
        unsafe { sys::opc_station_join(ssid.as_ptr(), password.as_ptr(), seq, out, capacity) }
    })
}

/// The video shooting mode a Pocket 4 Pro wants selected before it joins.
pub fn station_video_mode(seq: u16) -> Result<Vec<u8>, CameraError> {
    emit(|out, capacity| {
        // Safety: the core only writes into `out`.
        unsafe { sys::opc_station_video_mode(seq, out, capacity) }
    })
}

/// What the role query said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleDecision {
    AlreadyStation,
    /// An access point: set the role, then read it back until it says station.
    SetAndVerify,
    /// This body has no role getter: set it and go on without a readback.
    SetWithoutReadback,
    Reject,
}

/// Reads a `0x07/0x39` reply the way the core does.
pub fn role_decision(reply: &[u8], allow_missing_query: bool) -> RoleDecision {
    // Safety: `reply` outlives the call.
    match unsafe {
        sys::opc_station_role_decision(reply.as_ptr(), reply.len(), i32::from(allow_missing_query))
    } {
        0 => RoleDecision::AlreadyStation,
        1 => RoleDecision::SetAndVerify,
        2 => RoleDecision::SetWithoutReadback,
        _ => RoleDecision::Reject,
    }
}

/// Whether a `0x07/0x48` reply accepted the role change.
pub fn setter_accepts(reply: &[u8], missing_query: bool) -> bool {
    // Safety: `reply` outlives the call.
    let accepted = unsafe {
        sys::opc_station_setter_accepts(reply.as_ptr(), reply.len(), i32::from(missing_query))
    };
    accepted == 1
}

/// What a join reply said, on this attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinDecision {
    Connected,
    Retry,
    Rejected,
}

/// Reads a `0x07/0x47` reply the way the core does.
pub fn join_decision(reply: &[u8], attempt: u32) -> JoinDecision {
    // Safety: `reply` outlives the call.
    match unsafe {
        sys::opc_station_join_decision(
            reply.as_ptr(),
            reply.len(),
            attempt.min(i32::MAX as u32) as i32,
        )
    } {
        0 => JoinDecision::Connected,
        1 => JoinDecision::Retry,
        _ => JoinDecision::Rejected,
    }
}

/// The join's bounded retry, in seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JoinPolicy {
    pub attempts: u32,
    /// How long the radio gets between the role change and the first join.
    pub settle: f64,
    /// How long one join may go unanswered.
    pub reply_timeout: f64,
    pub retry_delay: f64,
}

impl JoinPolicy {
    /// The core's numbers.
    pub fn from_core() -> Self {
        let (mut attempts, mut settle, mut reply_timeout, mut retry_delay) =
            (0i32, 0i32, 0f64, 0i32);
        // Safety: four live out-pointers.
        unsafe {
            sys::opc_station_join_policy(
                &mut attempts,
                &mut settle,
                &mut reply_timeout,
                &mut retry_delay,
            );
        }
        Self {
            attempts: attempts.max(1) as u32,
            settle: f64::from(settle.max(0)),
            reply_timeout: reply_timeout.max(1.0),
            retry_delay: f64::from(retry_delay.max(0)),
        }
    }
}

/// How often the role is read back after a change, and how many times.
pub const ROLE_VERIFY_INTERVAL: f64 = 2.0;
pub const ROLE_VERIFY_READS: u32 = 6;
/// How long a reply other than the join's may take.
pub const REPLY_TIMEOUT: f64 = 12.0;

/// What to write to the camera next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StationStep {
    /// Read the camera's Wi-Fi name: the identity the LAN search checks against.
    Identity,
    /// Select video mode first (Pocket 4 Pro).
    VideoMode,
    QueryRole,
    SetStation,
    /// Read the role back; the camera says station once its radio has switched.
    VerifyRole,
    /// Join the network; `attempt` starts at 1.
    Join {
        attempt: u32,
    },
}

/// What the camera said, already read by the core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StationInput {
    Identity(Vec<u8>),
    /// Video mode was sent; there is nothing to wait for.
    VideoModeSent,
    Role(RoleDecision),
    SetterAccepted(bool),
    /// The role readback: `Some(true)` station, `Some(false)` still an access point,
    /// `None` an unexpected reply.
    RoleReadback(Option<bool>),
    Join(JoinDecision),
    /// The step went unanswered.
    Timeout,
}

/// Where the provisioning has got to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StationState {
    Working(&'static str),
    /// The camera accepted the join, or never answered it. `confirmed` is false in the
    /// second case: the LAN search decides.
    Done {
        identity: Vec<u8>,
        confirmed: bool,
    },
    Failed(String),
}

/// Drives the exchange.
#[derive(Debug)]
pub struct Provisioning {
    policy: JoinPolicy,
    video_mode: bool,
    allow_missing_query: bool,
    state: StationState,
    pending: Option<StationStep>,
    /// When the pending step may be sent; None means now.
    not_before: Option<f64>,
    identity: Vec<u8>,
    missing_query: bool,
    verify_reads: u32,
    attempt: u32,
}

impl Provisioning {
    /// `video_mode` sends the Pocket 4 Pro's mode select first. `allow_missing_query`
    /// lets a body without a role getter (Pocket 3, Nano) go on without a readback.
    pub fn new(policy: JoinPolicy, video_mode: bool, allow_missing_query: bool) -> Self {
        Self {
            policy,
            video_mode,
            allow_missing_query,
            state: StationState::Working("Reading the camera's identity"),
            pending: Some(StationStep::Identity),
            not_before: None,
            identity: Vec::new(),
            missing_query: false,
            verify_reads: 0,
            attempt: 0,
        }
    }

    pub fn state(&self) -> &StationState {
        &self.state
    }

    pub fn is_finished(&self) -> bool {
        matches!(
            self.state,
            StationState::Done { .. } | StationState::Failed(_)
        )
    }

    pub fn allow_missing_query(&self) -> bool {
        self.allow_missing_query
    }

    /// Whether the body reported no role getter, which changes how the setter's reply
    /// is read.
    pub fn missing_query(&self) -> bool {
        self.missing_query
    }

    /// The step to send now, if its time has come. Each step is handed out once; the
    /// caller reports the reply, or a timeout, through [`Self::receive`].
    pub fn next(&mut self, now: f64) -> Option<StationStep> {
        if self.is_finished() {
            return None;
        }
        if self.not_before.is_some_and(|at| now < at) {
            return None;
        }
        self.not_before = None;
        self.pending.take()
    }

    /// How long the reply to a step may take.
    pub fn reply_timeout(&self, step: &StationStep) -> f64 {
        match step {
            StationStep::Join { .. } => self.policy.reply_timeout,
            _ => REPLY_TIMEOUT,
        }
    }

    fn fail(&mut self, message: &str) {
        self.state = StationState::Failed(message.to_string());
        self.pending = None;
    }

    fn schedule(&mut self, step: StationStep, label: &'static str, delay: f64, now: f64) {
        self.state = StationState::Working(label);
        self.pending = Some(step);
        self.not_before = (delay > 0.0).then_some(now + delay);
    }

    fn schedule_join(&mut self, now: f64, delay: f64) {
        self.attempt += 1;
        self.schedule(
            StationStep::Join {
                attempt: self.attempt,
            },
            "Joining your Wi-Fi",
            delay,
            now,
        );
    }

    /// What the camera said to the step last handed out.
    pub fn receive(&mut self, now: f64, step: &StationStep, input: StationInput) {
        if self.is_finished() {
            return;
        }
        match (step, input) {
            (StationStep::Identity, StationInput::Identity(identity)) => {
                if identity.len() <= 2 || identity[0] != 0 {
                    self.fail("The camera did not report its Wi-Fi identity.");
                    return;
                }
                self.identity = identity;
                if self.video_mode {
                    self.schedule(StationStep::VideoMode, "Selecting video mode", 0.0, now);
                } else {
                    self.schedule(StationStep::QueryRole, "Asking the camera's Wi-Fi role", 0.0, now);
                }
            }
            (StationStep::VideoMode, StationInput::VideoModeSent) => {
                self.schedule(StationStep::QueryRole, "Asking the camera's Wi-Fi role", 2.0, now);
            }
            (StationStep::QueryRole, StationInput::Role(decision)) => match decision {
                RoleDecision::AlreadyStation => self.settle_then_join(now),
                RoleDecision::SetAndVerify => {
                    self.schedule(StationStep::SetStation, "Switching the camera to your Wi-Fi", 0.0, now);
                }
                RoleDecision::SetWithoutReadback => {
                    self.missing_query = true;
                    self.schedule(StationStep::SetStation, "Switching the camera to your Wi-Fi", 0.0, now);
                }
                RoleDecision::Reject => self.fail(
                    "This camera did not report a supported Wi-Fi mode. Joining a network is not available for it yet.",
                ),
            },
            (StationStep::SetStation, StationInput::SetterAccepted(accepted)) => {
                if !accepted {
                    self.fail("The camera did not accept joining a network.");
                } else if self.missing_query {
                    self.settle_then_join(now);
                } else {
                    self.verify_reads = 0;
                    self.schedule(StationStep::VerifyRole, "Waiting for the camera's radio", 0.0, now);
                }
            }
            (StationStep::VerifyRole, StationInput::RoleReadback(readback)) => match readback {
                Some(true) => self.settle_then_join(now),
                Some(false) => {
                    self.verify_reads += 1;
                    if self.verify_reads >= ROLE_VERIFY_READS {
                        self.fail("The camera's Wi-Fi is still starting. Try again with the camera nearby.");
                    } else {
                        self.schedule(
                            StationStep::VerifyRole,
                            "Waiting for the camera's radio",
                            ROLE_VERIFY_INTERVAL,
                            now,
                        );
                    }
                }
                None => self.fail("The camera answered its Wi-Fi role with something this build cannot read."),
            },
            (StationStep::Join { attempt }, StationInput::Join(decision)) => match decision {
                JoinDecision::Connected => {
                    self.state = StationState::Done {
                        identity: self.identity.clone(),
                        confirmed: true,
                    };
                    self.pending = None;
                }
                JoinDecision::Retry if *attempt < self.policy.attempts => {
                    self.schedule_join(now, self.policy.retry_delay);
                    self.state = StationState::Working("Retrying the Wi-Fi connection");
                }
                JoinDecision::Retry | JoinDecision::Rejected => self.fail(
                    "The camera could not join your Wi-Fi. Check the name and password, and that the network is in range and 2.4 GHz is on.",
                ),
            },
            (StationStep::Join { attempt }, StationInput::Timeout) => {
                // A lost Bluetooth reply is not proof the join failed; the LAN search
                // will say. But not before every attempt has had its chance.
                if *attempt < self.policy.attempts {
                    self.schedule_join(now, self.policy.retry_delay);
                } else {
                    self.state = StationState::Done {
                        identity: self.identity.clone(),
                        confirmed: false,
                    };
                    self.pending = None;
                }
            }
            (_, StationInput::Timeout) => {
                self.fail("The camera stopped answering over Bluetooth. Bring it closer and try again.");
            }
            (step, input) => {
                self.fail(&format!("unexpected {input:?} while at {step:?}"));
            }
        }
    }

    fn settle_then_join(&mut self, now: f64) {
        self.attempt = 0;
        self.schedule_join(now, self.policy.settle);
        self.state = StationState::Working("Waiting for the camera's Wi-Fi");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> JoinPolicy {
        JoinPolicy {
            attempts: 3,
            settle: 10.0,
            reply_timeout: 45.0,
            retry_delay: 5.0,
        }
    }

    fn identity() -> Vec<u8> {
        vec![0, 0x0b, b'O', b's', b'm', b'o']
    }

    #[test]
    fn an_access_point_camera_is_switched_verified_settled_and_joined() {
        let mut p = Provisioning::new(policy(), false, false);
        assert_eq!(p.next(0.0), Some(StationStep::Identity));
        assert_eq!(p.next(0.1), None, "one step at a time");
        p.receive(
            0.2,
            &StationStep::Identity,
            StationInput::Identity(identity()),
        );
        assert_eq!(p.next(0.2), Some(StationStep::QueryRole));
        p.receive(
            0.5,
            &StationStep::QueryRole,
            StationInput::Role(RoleDecision::SetAndVerify),
        );
        assert_eq!(p.next(0.5), Some(StationStep::SetStation));
        p.receive(
            0.8,
            &StationStep::SetStation,
            StationInput::SetterAccepted(true),
        );
        assert_eq!(p.next(0.8), Some(StationStep::VerifyRole));
        p.receive(
            1.0,
            &StationStep::VerifyRole,
            StationInput::RoleReadback(Some(false)),
        );
        assert_eq!(p.next(1.5), None, "the readback waits its interval");
        assert_eq!(p.next(3.0), Some(StationStep::VerifyRole));
        p.receive(
            3.2,
            &StationStep::VerifyRole,
            StationInput::RoleReadback(Some(true)),
        );
        assert_eq!(
            p.state(),
            &StationState::Working("Waiting for the camera's Wi-Fi")
        );
        assert_eq!(p.next(12.0), None, "the radio gets its settle");
        assert_eq!(p.next(13.3), Some(StationStep::Join { attempt: 1 }));
        assert_eq!(p.reply_timeout(&StationStep::Join { attempt: 1 }), 45.0);
        p.receive(
            14.0,
            &StationStep::Join { attempt: 1 },
            StationInput::Join(JoinDecision::Connected),
        );
        assert_eq!(
            p.state(),
            &StationState::Done {
                identity: identity(),
                confirmed: true
            }
        );
        assert_eq!(p.next(20.0), None);
    }

    #[test]
    fn a_camera_already_in_station_mode_goes_straight_to_the_join() {
        let mut p = Provisioning::new(policy(), false, false);
        p.next(0.0);
        p.receive(
            0.2,
            &StationStep::Identity,
            StationInput::Identity(identity()),
        );
        p.next(0.2);
        p.receive(
            0.5,
            &StationStep::QueryRole,
            StationInput::Role(RoleDecision::AlreadyStation),
        );
        assert_eq!(p.next(10.6), Some(StationStep::Join { attempt: 1 }));
    }

    #[test]
    fn a_body_without_a_role_getter_skips_the_readback() {
        let mut p = Provisioning::new(policy(), false, true);
        p.next(0.0);
        p.receive(
            0.2,
            &StationStep::Identity,
            StationInput::Identity(identity()),
        );
        p.next(0.2);
        p.receive(
            0.5,
            &StationStep::QueryRole,
            StationInput::Role(RoleDecision::SetWithoutReadback),
        );
        assert!(p.missing_query());
        assert_eq!(p.next(0.5), Some(StationStep::SetStation));
        p.receive(
            0.8,
            &StationStep::SetStation,
            StationInput::SetterAccepted(true),
        );
        assert_eq!(p.next(0.9), None);
        assert_eq!(p.next(10.9), Some(StationStep::Join { attempt: 1 }));
    }

    #[test]
    fn the_pocket_4_pro_selects_video_mode_first() {
        let mut p = Provisioning::new(policy(), true, false);
        p.next(0.0);
        p.receive(
            0.2,
            &StationStep::Identity,
            StationInput::Identity(identity()),
        );
        assert_eq!(p.next(0.2), Some(StationStep::VideoMode));
        p.receive(0.3, &StationStep::VideoMode, StationInput::VideoModeSent);
        assert_eq!(p.next(1.0), None, "two seconds for the mode to take");
        assert_eq!(p.next(2.4), Some(StationStep::QueryRole));
    }

    #[test]
    fn a_join_asked_to_retry_tries_again_then_gives_up() {
        let mut p = Provisioning::new(policy(), false, false);
        p.next(0.0);
        p.receive(
            0.2,
            &StationStep::Identity,
            StationInput::Identity(identity()),
        );
        p.next(0.2);
        p.receive(
            0.5,
            &StationStep::QueryRole,
            StationInput::Role(RoleDecision::AlreadyStation),
        );
        assert_eq!(p.next(11.0), Some(StationStep::Join { attempt: 1 }));
        p.receive(
            12.0,
            &StationStep::Join { attempt: 1 },
            StationInput::Join(JoinDecision::Retry),
        );
        assert_eq!(p.next(14.0), None, "five seconds between attempts");
        assert_eq!(p.next(17.1), Some(StationStep::Join { attempt: 2 }));
        p.receive(
            18.0,
            &StationStep::Join { attempt: 2 },
            StationInput::Join(JoinDecision::Retry),
        );
        assert_eq!(p.next(23.1), Some(StationStep::Join { attempt: 3 }));
        p.receive(
            24.0,
            &StationStep::Join { attempt: 3 },
            StationInput::Join(JoinDecision::Retry),
        );
        assert!(
            matches!(p.state(), StationState::Failed(message) if message.contains("could not join"))
        );
    }

    #[test]
    fn a_silent_join_is_left_for_the_lan_search_after_the_last_attempt() {
        let mut p = Provisioning::new(policy(), false, false);
        p.next(0.0);
        p.receive(
            0.2,
            &StationStep::Identity,
            StationInput::Identity(identity()),
        );
        p.next(0.2);
        p.receive(
            0.5,
            &StationStep::QueryRole,
            StationInput::Role(RoleDecision::AlreadyStation),
        );
        for attempt in 1..=3 {
            let step = p.next(100.0 * f64::from(attempt)).expect("a join");
            assert_eq!(step, StationStep::Join { attempt });
            p.receive(
                100.0 * f64::from(attempt) + 45.0,
                &step,
                StationInput::Timeout,
            );
        }
        assert_eq!(
            p.state(),
            &StationState::Done {
                identity: identity(),
                confirmed: false
            }
        );
    }

    #[test]
    fn refusals_and_silence_elsewhere_fail_with_a_reason() {
        let mut p = Provisioning::new(policy(), false, false);
        p.next(0.0);
        p.receive(
            0.2,
            &StationStep::Identity,
            StationInput::Identity(vec![1, 2, 3]),
        );
        assert!(matches!(p.state(), StationState::Failed(m) if m.contains("identity")));

        let mut p = Provisioning::new(policy(), false, false);
        p.next(0.0);
        p.receive(
            0.2,
            &StationStep::Identity,
            StationInput::Identity(identity()),
        );
        p.next(0.2);
        p.receive(
            0.5,
            &StationStep::QueryRole,
            StationInput::Role(RoleDecision::Reject),
        );
        assert!(matches!(p.state(), StationState::Failed(m) if m.contains("supported Wi-Fi mode")));

        let mut p = Provisioning::new(policy(), false, false);
        p.next(0.0);
        p.receive(12.5, &StationStep::Identity, StationInput::Timeout);
        assert!(matches!(p.state(), StationState::Failed(m) if m.contains("Bluetooth")));

        let mut p = Provisioning::new(policy(), false, false);
        p.next(0.0);
        p.receive(
            0.2,
            &StationStep::Identity,
            StationInput::Identity(identity()),
        );
        p.next(0.2);
        p.receive(
            0.5,
            &StationStep::QueryRole,
            StationInput::Role(RoleDecision::SetAndVerify),
        );
        p.next(0.5);
        p.receive(
            0.8,
            &StationStep::SetStation,
            StationInput::SetterAccepted(true),
        );
        for i in 0..6 {
            let at = 1.0 + 2.5 * f64::from(i);
            assert_eq!(p.next(at), Some(StationStep::VerifyRole));
            p.receive(
                at + 0.1,
                &StationStep::VerifyRole,
                StationInput::RoleReadback(Some(false)),
            );
        }
        assert!(matches!(p.state(), StationState::Failed(m) if m.contains("still starting")));
    }
}
