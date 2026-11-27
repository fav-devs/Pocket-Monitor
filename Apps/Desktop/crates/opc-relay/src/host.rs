//! A view-only sharing host on this PC (main af91c5b): the camera's own HEVC, re-framed
//! by the core's relay video encoder, to up to four watchers on the interface that reaches
//! the camera. Advertised under both `_pocket-mon._tcp` and the core's legacy
//! `_opc-mon._tcp` ([`crate::discovery::advertised_types`]), so Pocket Monitor phones and
//! PCs and upstream OpenPocketCine iPhones all find it.

use std::io;
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use mdns_sd::{IfKind, ServiceDaemon, ServiceInfo};
use opc_core_sys as sys;

use crate::discovery::{advertised_types, host_instance_name, local_host_name};
use crate::ffi::{self, ProtocolInfo, RelayVideo};
use crate::transport::Transport;

const MAX_WATCHERS: usize = 4;
const QUEUE_SIZE: usize = 8;
const POLL: Duration = Duration::from_millis(20);
const WRITE_TIMEOUT: Duration = Duration::from_millis(500);

type HostResult = Result<(), Box<dyn std::error::Error>>;

struct Frame {
    wire: Vec<u8>,
    keyframe: bool,
}

/// An opt-in, view-only host on the interface used to reach the camera.
#[derive(Debug)]
pub struct Host {
    input: SyncSender<(Vec<u8>, bool)>,
    exit: Receiver<String>,
    stopped: Arc<AtomicBool>,
    watchers: Arc<AtomicUsize>,
}

impl Host {
    pub fn start(camera: SocketAddr) -> io::Result<Self> {
        let (input, frames) = sync_channel(QUEUE_SIZE);
        let (report, exit) = sync_channel(1);
        let stopped = Arc::new(AtomicBool::new(false));
        let watchers = Arc::new(AtomicUsize::new(0));
        let worker_stop = Arc::clone(&stopped);
        let worker_count = Arc::clone(&watchers);
        thread::Builder::new()
            .name("opc-sharing".into())
            .spawn(move || {
                if let Err(error) = serve(camera, &frames, &worker_stop, &worker_count) {
                    let _ = report.send(error.to_string());
                }
            })?;
        Ok(Self {
            input,
            exit,
            stopped,
            watchers,
        })
    }

    /// Watchers connected right now (joined or joining).
    pub fn watchers(&self) -> usize {
        self.watchers.load(Ordering::Relaxed)
    }

    pub fn offer(&self, bytes: &[u8], recording: bool) -> bool {
        self.input.try_send((bytes.to_vec(), recording)).is_ok()
    }

    pub fn error(&self) -> Option<String> {
        self.exit.try_recv().ok()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
}

struct Watcher {
    socket: TcpStream,
    frames: SyncSender<Arc<Frame>>,
    worker: thread::JoinHandle<()>,
}

impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

/// This machine's name, for the advertised instance: `COMPUTERNAME` on Windows, the host
/// name elsewhere.
fn machine_name() -> Option<String> {
    let from_env = ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()));
    if from_env.is_some() || cfg!(windows) {
        return from_env;
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .map(|name| name.trim_end_matches(".local").to_string())
        .filter(|name| !name.is_empty())
}

fn serve(
    camera: SocketAddr,
    frames: &Receiver<(Vec<u8>, bool)>,
    stopped: &AtomicBool,
    watchers: &AtomicUsize,
) -> HostResult {
    let route = UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))?;
    route.connect(camera)?;
    let address = route.local_addr()?.ip();
    let listener = TcpListener::bind((address, 0))?;
    listener.set_nonblocking(true)?;
    let info = ProtocolInfo::load()?;
    let machine = machine_name();
    let instance = host_instance_name(machine.as_deref());
    let host_name = local_host_name(machine.as_deref());
    let port = listener.local_addr()?.port();
    let mut services = Vec::new();
    for service_type in advertised_types(&info) {
        services.push(ServiceInfo::new(
            &service_type,
            &instance,
            &host_name,
            address,
            port,
            [
                (info.txt_watchable.as_str(), "1"),
                (info.txt_camera.as_str(), "PocketMonitor"),
            ]
            .as_slice(),
        )?);
    }
    let hello = Arc::new(ffi::encode_hello(&instance, "", "")?);
    let state = Arc::new(ffi::read_only_state()?);
    let daemon = ServiceDaemon::new()?;
    daemon.disable_interface(IfKind::All)?;
    daemon.enable_interface(IfKind::Addr(address))?;
    let mut registered = Vec::new();
    let mut result: HostResult = Ok(());
    for service in services {
        let fullname = service.get_fullname().to_owned();
        match daemon.register(service) {
            Ok(()) => registered.push(fullname),
            Err(error) => {
                result = Err(error.into());
                break;
            }
        }
    }
    if result.is_ok() {
        result = broadcast(&listener, frames, stopped, info, hello, state, watchers);
    }
    for fullname in registered {
        let _ = daemon.unregister(&fullname);
    }
    let _ = daemon.shutdown();
    result
}

fn broadcast(
    listener: &TcpListener,
    frames: &Receiver<(Vec<u8>, bool)>,
    stopped: &AtomicBool,
    info: ProtocolInfo,
    hello: Arc<Vec<u8>>,
    state: Arc<Vec<u8>>,
    count: &AtomicUsize,
) -> HostResult {
    let video = RelayVideo::new();
    let mut watchers: Vec<Watcher> = Vec::new();
    while !stopped.load(Ordering::Relaxed) {
        watchers.retain(|watcher| !watcher.worker.is_finished());
        count.store(watchers.len(), Ordering::Relaxed);
        match listener.accept() {
            Ok((stream, _)) if watchers.len() < MAX_WATCHERS => {
                let (send, receive) = sync_channel(QUEUE_SIZE);
                let hello = Arc::clone(&hello);
                let state = Arc::clone(&state);
                let info = info.clone();
                let socket = stream.try_clone()?;
                let worker =
                    thread::Builder::new()
                        .name("opc-watcher".into())
                        .spawn(move || {
                            let _ = watch(stream, &receive, &info, &hello, &state);
                        })?;
                watchers.push(Watcher {
                    socket,
                    frames: send,
                    worker,
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.into()),
        }

        match frames.recv_timeout(POLL) {
            Ok((bytes, recording)) => {
                let (wire, keyframe) = video.frame(&bytes, recording)?;
                if !wire.is_empty() {
                    let frame = Arc::new(Frame { wire, keyframe });
                    // Disconnect slow watchers so missed reference frames never corrupt video.
                    watchers.retain(|watcher| watcher.frames.try_send(Arc::clone(&frame)).is_ok());
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
    Ok(())
}

fn watch(
    stream: TcpStream,
    frames: &Receiver<Arc<Frame>>,
    info: &ProtocolInfo,
    hello: &[u8],
    state: &[u8],
) -> HostResult {
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let mut transport = Transport::from_stream(stream)?;
    let deadline = Instant::now() + info.join_timeout;
    while Instant::now() < deadline {
        // Drain queued frames until the handshake is complete.
        if matches!(frames.try_recv(), Err(TryRecvError::Disconnected)) {
            return Ok(());
        }
        if let Some(message) = transport.next_message()? {
            if message.kind != sys::OPC_RELAY_KIND_HELLO
                || ffi::decode_hello(&message.payload)?.version != info.version
            {
                return Ok(());
            }
            transport.send(sys::OPC_RELAY_KIND_HELLO, hello)?;
            transport.send(sys::OPC_RELAY_KIND_STATE, state)?;
            let mut started = false;
            while let Ok(frame) = frames.recv() {
                started |= frame.keyframe;
                if started {
                    transport.write_wire(&frame.wire)?;
                }
            }
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(client: &mut Transport) -> crate::transport::Message {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(message) = client.next_message().unwrap() {
                return message;
            }
            assert!(Instant::now() < deadline, "relay did not send a message");
        }
    }

    #[test]
    fn two_watchers_join_view_only_and_receive_the_same_keyframe() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let (pictures, receive) = sync_channel(QUEUE_SIZE);
        let worker = thread::spawn(move || {
            broadcast(
                &listener,
                &receive,
                &AtomicBool::new(false),
                ProtocolInfo::load().unwrap(),
                Arc::new(ffi::encode_hello("Windows host", "", "").unwrap()),
                Arc::new(ffi::read_only_state().unwrap()),
                &AtomicUsize::new(0),
            )
            .unwrap();
        });

        let mut clients = Vec::new();
        for _ in 0..2 {
            let mut client =
                Transport::connect(&[address.ip()], address.port(), Duration::from_secs(2))
                    .unwrap();
            let hello = ffi::encode_hello("Watcher", "", "").unwrap();
            client.send(sys::OPC_RELAY_KIND_HELLO, &hello).unwrap();
            assert_eq!(message(&mut client).kind, sys::OPC_RELAY_KIND_HELLO);
            let state = message(&mut client);
            assert_eq!(state.kind, sys::OPC_RELAY_KIND_STATE);
            assert!(
                !ffi::decode_state(&state.payload)
                    .unwrap()
                    .allows_control_requests
            );
            clients.push(client);
        }

        let configuration = [
            0, 0, 1, 64, 1, 128, 0, 0, 1, 66, 1, 128, 0, 0, 1, 68, 1, 128,
        ];
        pictures.send((configuration.to_vec(), false)).unwrap();
        pictures.send((vec![0, 0, 1, 2, 1, 128], false)).unwrap();
        pictures.send((vec![0, 0, 1, 40, 1, 128], true)).unwrap();

        for mut client in clients {
            let frame = message(&mut client);
            assert_eq!(frame.kind, sys::OPC_RELAY_KIND_FRAME);
            let blob = ffi::decode_frame_blob(&frame.payload).unwrap();
            assert!(blob.meta.is_keyframe);
            assert!(blob.meta.is_recording);
            assert_eq!(blob.meta.parameter_set_count, 3);
            assert_eq!(
                &frame.payload[blob.access_unit],
                &[
                    0, 0, 0, 1, 64, 1, 128, 0, 0, 0, 1, 66, 1, 128, 0, 0, 0, 1, 68, 1, 128, 0, 0,
                    0, 1, 40, 1, 128,
                ]
            );
        }

        drop(pictures);
        worker.join().unwrap();
    }
}
