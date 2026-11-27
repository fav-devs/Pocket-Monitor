import ActivityKit
import Foundation

/// The Live Activity's data. The widget extension declares the same type
/// (`targets/pocket-live/PocketLiveActivityAttributes.swift`): ActivityKit pairs the app's request
/// with the extension's `ActivityConfiguration` by this type, so the name and every Codable field
/// must stay identical in both files.
// VERIFY: the app-side (PocketNative pod) and extension-side copies are matched by ActivityKit
// (the same pattern expo-live-activity uses); the Lock Screen shows the activity on request.
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

/// Starts, updates and ends the one Pocket Monitor Live Activity. Local updates only (no push
/// token): every update moves `staleDate` forward, so when iOS suspends the app the activity turns
/// stale on its own and the widget says so.
actor PocketLiveActivityController {
  static let shared = PocketLiveActivityController()

  /// JS sends a heartbeat every 30 s while it runs; three missed beats is stale.
  static let staleAfter: TimeInterval = 90

  private var activity: Activity<PocketLiveActivityAttributes>?
  private var lastState: PocketLiveActivityAttributes.ContentState?
  /// Set while the app expects to be suspended (grace task running): staleDate never passes it, so
  /// JS heartbeats during the grace period do not push it out again.
  private var suspensionDeadline: Date?
  private var deadlineGeneration = 0

  nonisolated var areEnabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

  /// Ends every activity left from an earlier run (the app was killed while live).
  func endLeftovers() async {
    for leftover in Activity<PocketLiveActivityAttributes>.activities where leftover.id != activity?.id {
      await leftover.end(nil, dismissalPolicy: .immediate)
    }
  }

  /// Returns the activity id, or nil when Live Activities are off for the app.
  func start(cameraName: String, cameraModel: String, state: PocketLiveActivityAttributes.ContentState) async throws
    -> String?
  {
    guard areEnabled else { return nil }
    if let activity, activity.activityState == .active || activity.activityState == .stale {
      await update(state)
      return activity.id
    }
    await endLeftovers()
    let attributes = PocketLiveActivityAttributes(cameraName: cameraName, cameraModel: cameraModel)
    let created = try Activity.request(attributes: attributes, content: content(state), pushType: nil)
    activity = created
    lastState = state
    return created.id
  }

  /// False when there is no running activity (never started, ended, or dismissed by the operator).
  @discardableResult
  func update(_ state: PocketLiveActivityAttributes.ContentState) async -> Bool {
    guard let activity, activity.activityState == .active || activity.activityState == .stale else { return false }
    lastState = state
    await activity.update(content(state))
    return true
  }

  /// `deadline`: the app expects to be suspended then (grace task without Picture in Picture), so
  /// the activity turns stale at that time; nil clears it. Calls carry a generation from
  /// `PocketBackgroundGrace` because tasks may reach this actor out of order.
  func setSuspensionDeadline(_ deadline: Date?, generation: Int) async {
    guard generation > deadlineGeneration else { return }
    deadlineGeneration = generation
    suspensionDeadline = deadline
    guard let lastState else { return }
    await update(lastState)
  }

  func end(final state: PocketLiveActivityAttributes.ContentState?, immediate: Bool) async {
    guard let activity else {
      await endLeftovers()
      return
    }
    self.activity = nil
    lastState = nil
    suspensionDeadline = nil
    let final = state.map { ActivityContent(state: $0, staleDate: nil) }
    await activity.end(final, dismissalPolicy: immediate ? .immediate : .after(Date().addingTimeInterval(8)))
  }

  private func content(_ state: PocketLiveActivityAttributes.ContentState) -> ActivityContent<PocketLiveActivityAttributes.ContentState> {
    var stale = Date().addingTimeInterval(Self.staleAfter)
    if let suspensionDeadline, suspensionDeadline < stale { stale = suspensionDeadline }
    return ActivityContent(state: state, staleDate: stale, relevanceScore: score(state))
  }

  private func score(_ state: PocketLiveActivityAttributes.ContentState) -> Double {
    state.recording ? 100 : 50
  }
}
