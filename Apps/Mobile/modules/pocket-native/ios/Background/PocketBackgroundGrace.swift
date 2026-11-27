import Foundation
import UIKit

/// Keeps the camera session through a quick app switch.
///
/// While JS has it armed (live), leaving the foreground starts a `beginBackgroundTask`, so iOS lets
/// the process (datalink, 40 Hz ACK pump, JS timers) run for its background allowance instead of
/// suspending within seconds. The task ends when the app returns, when Picture in Picture takes
/// over (PiP keeps the app running on its own) or when iOS expires it. Nothing here touches the
/// camera: on return the session's own watchdog repairs a stalled feed (CONTEXT.md "Watchdog").
@MainActor
final class PocketBackgroundGrace {
  static let shared = PocketBackgroundGrace()

  /// Fires when the grace task starts or ends (`true` while one runs).
  var onChange: ((Bool) -> Void)?

  private(set) var armed = false
  private var task: UIBackgroundTaskIdentifier = .invalid
  private var intentTask: UIBackgroundTaskIdentifier = .invalid
  private var observers: [NSObjectProtocol] = []
  /// Orders the stale-horizon changes sent to the Live Activity actor.
  private var horizonGeneration = 0

  var isRunning: Bool { task != .invalid }

  func install() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { PocketPictureInPicture.shared.willResignActive() }
      },
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { PocketBackgroundGrace.shared.didEnterBackground() }
      },
      center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { PocketBackgroundGrace.shared.willEnterForeground() }
      },
    ]
    PocketPictureInPicture.shared.onStoppedInBackground = {
      // The operator closed the PiP window while away: same grace as a plain app switch.
      PocketBackgroundGrace.shared.didEnterBackground()
    }
  }

  func setArmed(_ on: Bool) {
    armed = on
    if !on { end() }
  }

  func pictureInPictureStarted() {
    end()
    setActivityHorizon(nil)
  }

  private func willEnterForeground() {
    end()
    // Also after an expired grace task: the suspension horizon no longer applies.
    setActivityHorizon(nil)
  }

  /// `seconds`: the app expects to be suspended that soon, so the Live Activity should read stale
  /// then rather than 90 s after the last heartbeat. nil: the app keeps running.
  private func setActivityHorizon(_ seconds: TimeInterval?) {
    horizonGeneration += 1
    let generation = horizonGeneration
    let deadline = seconds.map { Date().addingTimeInterval($0) }
    Task { await PocketLiveActivityController.shared.setSuspensionDeadline(deadline, generation: generation) }
  }

  /// A Live Activity or Control intent reached a backgrounded app: give JS a few seconds to send
  /// the command before iOS suspends the process again.
  func holdForIntent(seconds: TimeInterval = 8) {
    guard UIApplication.shared.applicationState != .active, intentTask == .invalid else { return }
    intentTask = UIApplication.shared.beginBackgroundTask(withName: "Pocket Monitor intent") {
      MainActor.assumeIsolated { PocketBackgroundGrace.shared.endIntentHold() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
      MainActor.assumeIsolated { PocketBackgroundGrace.shared.endIntentHold() }
    }
  }

  private func endIntentHold() {
    guard intentTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(intentTask)
    intentTask = .invalid
  }

  private func didEnterBackground() {
    guard armed, task == .invalid, !PocketPictureInPicture.shared.isActive else { return }
    // PiP auto-start may still be coming up at this point; its didStart ends this task.
    task = UIApplication.shared.beginBackgroundTask(withName: "Pocket Monitor live grace") {
      // Expired: iOS suspends the app next. The activity keeps the stale horizon set below.
      MainActor.assumeIsolated { PocketBackgroundGrace.shared.end() }
    }
    guard task != .invalid else { return }
    onChange?(true)
    let remaining = UIApplication.shared.backgroundTimeRemaining
    setActivityHorizon((remaining.isFinite ? min(max(remaining, 5), 180) : 30) + 5)
  }

  func end() {
    guard task != .invalid else { return }
    UIApplication.shared.endBackgroundTask(task)
    task = .invalid
    onChange?(false)
  }
}
