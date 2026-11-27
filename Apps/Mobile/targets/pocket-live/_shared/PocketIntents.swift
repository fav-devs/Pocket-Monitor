import AppIntents
import Foundation
import WidgetKit

// Compiled into BOTH the main app and the widget extension (`_shared`, @bacons/apple-targets).
// LiveActivityIntent.perform runs in the app process, where the PocketBackground module listens.
// Names below mirror modules/pocket-native/ios/Background/PocketBackgroundShared.swift.

enum PocketSharedState {
  static let appGroup = "group.com.favdevs.pocketmonitor"
  static let intentNotification = Notification.Name("com.favdevs.pocketmonitor.background.intent")
  static let recordControlKind = "com.favdevs.pocketmonitor.control.record"

  enum Key {
    static let live = "pm.live"
    static let recording = "pm.recording"
    static let cameraName = "pm.cameraName"
    static let pendingRecording = "pm.pendingRecording"
    static let pendingAt = "pm.pendingAt"
  }

  /// How long an optimistic value from the control outlives the camera's answer.
  static let pendingWindow: TimeInterval = 4

  static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

  struct Snapshot: Sendable, Hashable {
    var live: Bool
    var recording: Bool
    var cameraName: String?
  }

  static func read() -> Snapshot {
    guard let d = defaults else { return Snapshot(live: false, recording: false, cameraName: nil) }
    var recording = d.bool(forKey: Key.recording)
    if let at = d.object(forKey: Key.pendingAt) as? Double, Date().timeIntervalSince1970 - at < pendingWindow {
      recording = d.bool(forKey: Key.pendingRecording)
    }
    return Snapshot(live: d.bool(forKey: Key.live), recording: recording, cameraName: d.string(forKey: Key.cameraName))
  }

  static func setPending(recording: Bool) {
    guard let d = defaults else { return }
    d.set(recording, forKey: Key.pendingRecording)
    d.set(Date().timeIntervalSince1970, forKey: Key.pendingAt)
  }

  static func markNotLive() {
    guard let d = defaults else { return }
    d.set(false, forKey: Key.live)
    d.set(false, forKey: Key.recording)
    d.removeObject(forKey: Key.pendingAt)
  }

  static func reloadControls() {
    if #available(iOS 18.0, *) {
      ControlCenter.shared.reloadControls(ofKind: recordControlKind)
    }
  }
}

enum PocketIntentRelay {
  /// True in the app; false inside the widget extension (`.appex`).
  static var inAppProcess: Bool { Bundle.main.bundleURL.pathExtension != "appex" }

  /// Hands `action` to the app's JS session. Returns whether a live session took it. Fast: the
  /// camera's answer comes back through the normal state path (and a Live Activity update).
  @discardableResult
  static func send(_ action: String, pendingRecording: Bool?) -> Bool {
    // VERIFY: on device, Live Activity buttons and the control run perform() in the app process
    // (LiveActivityIntent), waking the app in the background when it is suspended.
    guard inAppProcess else { return false }
    let reply = NSMutableDictionary()
    NotificationCenter.default.post(name: PocketSharedState.intentNotification, object: reply, userInfo: ["action": action])
    let handled = (reply["handled"] as? Bool) == true
    if handled {
      if let pendingRecording { PocketSharedState.setPending(recording: pendingRecording) }
    } else {
      // Nothing is listening: the app was not live (or was relaunched in the background).
      PocketSharedState.markNotLive()
    }
    PocketSharedState.reloadControls()
    return handled
  }
}

/// Record / Stop: Live Activity buttons and the Control Center toggle (`value` = record).
@available(iOS 17.0, *)
struct PocketSetRecordingIntent: SetValueIntent, LiveActivityIntent {
  static let title: LocalizedStringResource = "Record"
  static let description = IntentDescription("Start or stop recording on the connected camera.")
  static let isDiscoverable = true

  @Parameter(title: "Recording")
  var value: Bool

  init() {}

  init(value: Bool) {
    self.value = value
  }

  func perform() async throws -> some IntentResult {
    PocketIntentRelay.send(value ? "startRecording" : "stopRecording", pendingRecording: value)
    return .result()
  }
}

/// Disconnect: Live Activity button.
@available(iOS 17.0, *)
struct PocketDisconnectIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Disconnect"
  static let description = IntentDescription("Disconnect from the camera.")
  static let isDiscoverable = false

  init() {}

  func perform() async throws -> some IntentResult {
    PocketIntentRelay.send("disconnect", pendingRecording: nil)
    return .result()
  }
}
