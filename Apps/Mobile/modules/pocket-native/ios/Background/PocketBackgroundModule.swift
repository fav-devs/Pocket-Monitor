import ExpoModulesCore
import Foundation
import UIKit

/// `IosBackgroundCapabilities` in src/types.ts.
@Record
struct PocketBackgroundCapabilities {
  var liveActivities: Bool = false
  var pictureInPicture: Bool = false
  /// iOS 18 Control Center / Lock Screen / Action button control.
  var controls: Bool = false
}

@Record
struct PocketLiveActivityStartRecord {
  var cameraName: String = ""
  var cameraModel: String = ""
}

/// `LiveActivityState` in src/types.ts.
@Record
struct PocketLiveActivityStateRecord {
  var phase: String = "live"
  var recording: Bool = false
  /// Epoch milliseconds of the take start; null when not recording.
  var recordingStartedAtMs: Double? = nil
  var remainingSec: Int = -1
  var batteryPercent: Int = -1
  var charging: Bool = false
  var linkBand: String = "stable"
  var signalBars: Int = 0
}

extension PocketLiveActivityStateRecord {
  var contentState: PocketLiveActivityAttributes.ContentState {
    PocketLiveActivityAttributes.ContentState(
      phase: phase,
      recording: recording,
      recordingStartedAt: recording ? recordingStartedAtMs.map { Date(timeIntervalSince1970: $0 / 1000) } : nil,
      remainingSec: remainingSec,
      batteryPercent: batteryPercent,
      charging: charging,
      linkBand: linkBand,
      signalBars: signalBars)
  }
}

/// Shared with Android: `onAction` `{ action: ServerAction }`.
@Record
struct PocketBackgroundActionEvent {
  /// "record" | "stop" | "disconnect"
  var action: String = ""
}

@Record
struct PocketPipStateEvent {
  var prepared: Bool = false
  var possible: Bool = false
  var active: Bool = false
}

/// Shared with Android: `onServerState` `{ running, reason }`. iOS reasons: "pip" | "grace".
@Record
struct PocketServerStateEvent {
  var running: Bool = false
  var reason: String? = nil
}

/// JS module `PocketBackground` (src/types.ts → `PocketBackgroundNativeModule`), iOS side:
/// Live Activity (ActivityKit), Picture in Picture monitoring, the record control's shared state and
/// the background grace task. App Intents from the Live Activity buttons and the Control Center
/// control arrive as `onAction` (see `PocketBackgroundShared.intentNotification`). `isServing`,
/// `onAction` and `onServerState` are shared with the Android module of the same JS name.
@ExpoModule("PocketBackground")
public final class PocketBackgroundModule: Module {
  private let lock = NSLock()
  // lock-protected
  private var intentListening = false
  private var pipActive = false
  private var graceRunning = false
  private var observers: [NSObjectProtocol] = []

  @Event("onAction")
  var onAction: (PocketBackgroundActionEvent) -> Void

  @Event("onPipState")
  var onPipState: (PocketPipStateEvent) -> Void

  @Event("onServerState")
  var onServerState: (PocketServerStateEvent) -> Void

  public override func didCreate() {
    let center = NotificationCenter.default
    let intents = center.addObserver(forName: PocketBackgroundShared.intentNotification, object: nil, queue: nil) {
      [weak self] note in
      // Synchronous on the intent's thread: the reply box must be filled before `post` returns.
      self?.handleIntent(note)
    }
    let terminate = center.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: nil) { _ in
      // Best effort: an activity left running after the app is gone would show stale data.
      let done = DispatchSemaphore(value: 0)
      Task.detached {
        await PocketLiveActivityController.shared.end(final: nil, immediate: true)
        done.signal()
      }
      _ = done.wait(timeout: .now() + 1)
      PocketBackgroundShared.writeControlState(live: false, recording: false, cameraName: nil)
    }
    lock.lock()
    observers = [intents, terminate]
    lock.unlock()
    // A fresh process is never live; anything shown from an earlier run is stale.
    PocketBackgroundShared.writeControlState(live: false, recording: false, cameraName: nil)
    Task { await PocketLiveActivityController.shared.endLeftovers() }
    Task { @MainActor [weak self] in
      PocketBackgroundGrace.shared.install()
      PocketPictureInPicture.shared.onState = { state in
        self?.pipChanged(state)
      }
      PocketBackgroundGrace.shared.onChange = { running in
        self?.graceChanged(running)
      }
    }
  }

  public override func willDestroy() {
    lock.lock()
    let list = observers
    observers = []
    lock.unlock()
    list.forEach { NotificationCenter.default.removeObserver($0) }
    Task { @MainActor in
      PocketPictureInPicture.shared.onState = nil
      PocketBackgroundGrace.shared.onChange = nil
      PocketPictureInPicture.shared.release()
      PocketBackgroundGrace.shared.setArmed(false)
    }
  }

  public override func didStartListening(event: String) {
    guard event == "onAction" else { return }
    lock.lock()
    intentListening = true
    lock.unlock()
  }

  public override func didStopListening(event: String) {
    guard event == "onAction" else { return }
    lock.lock()
    intentListening = false
    lock.unlock()
  }

  // MARK: Shared with Android

  /// iOS: something keeps the process running in the background right now (Picture in Picture, or
  /// the grace task). Android: the foreground service runs.
  @JS
  func isServing() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return pipActive || graceRunning
  }

  // MARK: iOS only

  @JS @MainActor
  func iosCapabilities() async -> PocketBackgroundCapabilities {
    var controls = false
    if #available(iOS 18.0, *) { controls = true }
    return PocketBackgroundCapabilities(
      liveActivities: PocketLiveActivityController.shared.areEnabled,
      pictureInPicture: PocketPictureInPicture.isSupported,
      controls: controls)
  }

  // MARK: Live Activity

  /// Returns the activity id, or null when Live Activities are turned off for the app.
  @JS
  func startLiveActivity(attributes: PocketLiveActivityStartRecord, state: PocketLiveActivityStateRecord) async throws -> String? {
    do {
      return try await PocketLiveActivityController.shared.start(
        cameraName: attributes.cameraName, cameraModel: attributes.cameraModel, state: state.contentState)
    } catch {
      throw Exception(name: "ERR_POCKET_LIVE_ACTIVITY", description: "\(error)")
    }
  }

  /// False when no activity is running (never started, ended, or dismissed by the operator).
  @JS
  func updateLiveActivity(state: PocketLiveActivityStateRecord) async -> Bool {
    await PocketLiveActivityController.shared.update(state.contentState)
  }

  @JS
  func endLiveActivity(state: PocketLiveActivityStateRecord?, immediate: Bool) async {
    await PocketLiveActivityController.shared.end(final: state?.contentState, immediate: immediate)
  }

  // MARK: Record control (Control Center / Lock Screen / Action button)

  @JS
  func setRecordControlState(live: Bool, recording: Bool, cameraName: String?) {
    PocketBackgroundShared.writeControlState(live: live, recording: recording, cameraName: cameraName)
  }

  // MARK: Picture in Picture

  @JS @MainActor
  func pipPrepare(sessionId: String) async -> Bool {
    PocketPictureInPicture.shared.prepare(sessionId: sessionId)
  }

  @JS @MainActor
  func pipRelease() async {
    PocketPictureInPicture.shared.release()
  }

  @JS @MainActor
  func pipStart() async -> Bool {
    PocketPictureInPicture.shared.start()
  }

  @JS @MainActor
  func pipStop() async {
    PocketPictureInPicture.shared.stop()
  }

  @JS @MainActor
  func setPipAutoStart(enabled: Bool) async {
    PocketPictureInPicture.shared.setAutoStart(enabled)
  }

  // MARK: Grace period

  /// Armed while live: leaving the foreground without PiP starts a background task.
  @JS @MainActor
  func setGraceArmed(armed: Bool) async {
    PocketBackgroundGrace.shared.setArmed(armed)
  }

  // MARK: Private

  private func handleIntent(_ note: Notification) {
    let action: String
    switch note.userInfo?["action"] as? String {
    case "startRecording": action = "record"
    case "stopRecording": action = "stop"
    case "disconnect": action = "disconnect"
    default: return
    }
    lock.lock()
    let listening = intentListening
    lock.unlock()
    guard listening else { return }
    (note.object as? NSMutableDictionary)?["handled"] = true
    onAction(PocketBackgroundActionEvent(action: action))
    Task { @MainActor in PocketBackgroundGrace.shared.holdForIntent() }
  }

  private func pipChanged(_ state: PocketPictureInPicture.State) {
    lock.lock()
    pipActive = state.active
    lock.unlock()
    onPipState(PocketPipStateEvent(prepared: state.prepared, possible: state.possible, active: state.active))
    emitServing()
  }

  private func graceChanged(_ running: Bool) {
    lock.lock()
    graceRunning = running
    lock.unlock()
    emitServing()
  }

  private func emitServing() {
    lock.lock()
    let reason: String? = pipActive ? "pip" : graceRunning ? "grace" : nil
    lock.unlock()
    onServerState(PocketServerStateEvent(running: reason != nil, reason: reason))
  }
}
