import AppIntents
import SwiftUI
import WidgetKit

/// iOS 18 control: Control Center, the Lock Screen and the Action button toggle recording on the
/// connected camera through the same `PocketSetRecordingIntent` the Live Activity uses. Its value
/// comes from the app group (written by the app on every REC / live change).
@available(iOS 18.0, *)
struct PocketRecordControl: ControlWidget {
  static let kind = PocketSharedState.recordControlKind

  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: Self.kind, provider: PocketRecordControlProvider()) { value in
      ControlWidgetToggle("Record", isOn: value.recording, action: PocketSetRecordingIntent()) { isOn in
        Label(
          isOn ? "Recording" : value.live ? "Standby" : "No camera",
          systemImage: isOn ? "record.circle.fill" : "record.circle")
      }
      .tint(PocketStyle.recordRed)  // VERIFY: ControlWidgetTemplate.tint on iOS 18
    }
    .displayName("Record")
    .description("Start or stop recording on the connected camera.")
  }
}

@available(iOS 18.0, *)
struct PocketRecordControlProvider: ControlValueProvider {
  var previewValue: PocketSharedState.Snapshot {
    PocketSharedState.Snapshot(live: true, recording: false, cameraName: nil)
  }

  func currentValue() async throws -> PocketSharedState.Snapshot {
    PocketSharedState.read()
  }
}
