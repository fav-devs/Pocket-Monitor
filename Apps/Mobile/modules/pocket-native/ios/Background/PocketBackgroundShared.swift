import Foundation
import WidgetKit

/// Values the app shares with the widget extension (`targets/pocket-live`). The extension keeps its
/// own copy of these names in `targets/pocket-live/_shared/PocketIntents.swift`; keep both in sync.
enum PocketBackgroundShared {
  /// `ios.entitlements["com.apple.security.application-groups"]` in app.json (mirrored onto the
  /// extension by @bacons/apple-targets).
  static let appGroup = "group.com.favdevs.pocketmonitor"

  /// Posted in the app process by the App Intents (`PocketSetRecordingIntent`,
  /// `PocketDisconnectIntent`). `object` is an `NSMutableDictionary` reply box; observers set
  /// `handled = true` when the app's JS side took the action. `userInfo["action"]` is the action.
  static let intentNotification = Notification.Name("com.favdevs.pocketmonitor.background.intent")

  /// `ControlWidget` kind of the Control Center / Lock Screen / Action button record control.
  static let recordControlKind = "com.favdevs.pocketmonitor.control.record"

  enum Key {
    static let live = "pm.live"
    static let recording = "pm.recording"
    static let cameraName = "pm.cameraName"
    static let pendingRecording = "pm.pendingRecording"
    static let pendingAt = "pm.pendingAt"
    static let updatedAt = "pm.updatedAt"
  }

  static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

  /// What the record control shows. Clears an optimistic pending value from an intent.
  static func writeControlState(live: Bool, recording: Bool, cameraName: String?) {
    guard let d = defaults else { return }
    let changed = d.bool(forKey: Key.live) != live || d.bool(forKey: Key.recording) != recording
      || d.object(forKey: Key.pendingAt) != nil
    d.set(live, forKey: Key.live)
    d.set(recording, forKey: Key.recording)
    d.set(cameraName, forKey: Key.cameraName)
    d.removeObject(forKey: Key.pendingRecording)
    d.removeObject(forKey: Key.pendingAt)
    d.set(Date().timeIntervalSince1970, forKey: Key.updatedAt)
    if changed { reloadControls() }
  }

  static func reloadControls() {
    if #available(iOS 18.0, *) {
      ControlCenter.shared.reloadControls(ofKind: recordControlKind)
    }
  }
}
