import ActivityKit
import Foundation

/// Must match `modules/pocket-native/ios/Background/PocketLiveActivity.swift` exactly (type name and
/// every Codable field): the app requests the activity with its copy, this extension renders it.
struct PocketLiveActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// "live" | "recovering" | "ended"
    var phase: String
    var recording: Bool
    /// Start of the current take, for `Text(timerInterval:)` (counts without app updates).
    var recordingStartedAt: Date?
    /// Card record time left, seconds; -1 unknown.
    var remainingSec: Int
    /// Camera battery, percent; -1 unknown.
    var batteryPercent: Int
    var charging: Bool
    /// "stable" | "watch" | "poor"
    var linkBand: String
    /// 0–4
    var signalBars: Int
  }

  var cameraName: String
  var cameraModel: String
}
