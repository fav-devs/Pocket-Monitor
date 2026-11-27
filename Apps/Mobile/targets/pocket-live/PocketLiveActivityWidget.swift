import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// Lock Screen banner and Dynamic Island for a live camera. Everything shown comes from the app's
/// local updates; the elapsed time is `Text(timerInterval:)`, so it keeps counting while the app
/// sends nothing. A stale activity (the app was suspended) keeps the camera's REC and timer (the
/// camera keeps rolling on its own) but drops the buttons, which need the app.
struct PocketLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PocketLiveActivityAttributes.self) { context in
      PocketLockScreenView(attributes: context.attributes, state: context.state, isStale: context.isStale)
        .activityBackgroundTint(PocketStyle.tile)
        .activitySystemActionForegroundColor(PocketStyle.foreground)
        .widgetURL(PocketStyle.liveURL)
    } dynamicIsland: { context in
      let state = context.state
      let stale = context.isStale
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 8) {
            PocketLogoMark(size: 26)
            Text(context.attributes.cameraName)
              .font(PocketStyle.font(.semibold, 15))
              .foregroundStyle(PocketStyle.foreground)
              .lineLimit(1)
          }
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          PocketTelemetry(state: state)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 10) {
            PocketRecLine(state: state, isStale: stale, timerSize: 28)
            if stale {
              PocketStaleNote()
            } else {
              PocketActionButtons(state: state)
            }
          }
          .padding(.horizontal, 4)
        }
      } compactLeading: {
        if state.recording {
          PocketRecDot(recording: true, size: 10)
        } else {
          PocketLogoMark(size: 20, tile: false)
        }
      } compactTrailing: {
        if state.recording {
          PocketElapsed(state: state)
            .font(PocketStyle.font(.semibold, 14))
            .foregroundStyle(PocketStyle.recordRed)
            .frame(maxWidth: 56, alignment: .trailing)
        } else if state.batteryPercent >= 0 {
          Text("\(state.batteryPercent)%")
            .font(PocketStyle.font(.semibold, 14))
            .monospacedDigit()
            .foregroundStyle(PocketStyle.batteryColor(state.batteryPercent))
        }
      } minimal: {
        if state.recording {
          PocketRecDot(recording: true, size: 10)
        } else {
          PocketLogoMark(size: 20, tile: false)
        }
      }
      .widgetURL(PocketStyle.liveURL)
      .keylineTint(state.recording ? PocketStyle.recordRed : PocketStyle.foreground)
    }
  }
}

/// Lock Screen / banner (and StandBy).
struct PocketLockScreenView: View {
  let attributes: PocketLiveActivityAttributes
  let state: PocketLiveActivityAttributes.ContentState
  let isStale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        PocketLogoMark(size: 30)
        VStack(alignment: .leading, spacing: 1) {
          Text(attributes.cameraName)
            .font(PocketStyle.font(.semibold, 15))
            .foregroundStyle(PocketStyle.foreground)
            .lineLimit(1)
          Text(subtitle)
            .font(PocketStyle.font(.medium, 12))
            .foregroundStyle(PocketStyle.muted)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        PocketTelemetry(state: state)
      }
      PocketRecLine(state: state, isStale: isStale, timerSize: 30)
      if isStale {
        PocketStaleNote()
      } else {
        PocketActionButtons(state: state)
      }
    }
    .padding(16)
  }

  private var subtitle: String {
    if isStale { return "Link paused" }
    if state.phase == "recovering" { return "Reconnecting" }
    return "Card \(PocketStyle.remaining(state.remainingSec))"
  }
}

/// REC dot, REC/STBY and the system-driven elapsed time.
struct PocketRecLine: View {
  let state: PocketLiveActivityAttributes.ContentState
  let isStale: Bool
  var timerSize: CGFloat = 28

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      PocketRecDot(recording: state.recording, size: 10)
        .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 2 }
      Text(state.recording ? "REC" : "STBY")
        .font(PocketStyle.font(.bold, 13))
        .foregroundStyle(state.recording ? PocketStyle.recordRed : PocketStyle.muted)
      PocketElapsed(state: state)
        .font(PocketStyle.font(.bold, timerSize))
        .foregroundStyle(isStale ? PocketStyle.muted : PocketStyle.foreground)
        .lineLimit(1)
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}

struct PocketElapsed: View {
  let state: PocketLiveActivityAttributes.ContentState

  var body: some View {
    if state.recording, let start = state.recordingStartedAt {
      Text(timerInterval: start...Date.distantFuture, countsDown: false)
        .monospacedDigit()
    } else {
      Text("00:00").monospacedDigit()
    }
  }
}

/// Link bars and camera battery.
struct PocketTelemetry: View {
  let state: PocketLiveActivityAttributes.ContentState

  var body: some View {
    HStack(spacing: 8) {
      PocketLinkBars(bars: state.phase == "recovering" ? 0 : state.signalBars, band: state.linkBand)
      if state.batteryPercent >= 0 {
        HStack(spacing: 3) {
          Image(systemName: state.charging ? "battery.100percent.bolt" : batterySymbol)
            .font(.system(size: 13, weight: .semibold))
          Text("\(state.batteryPercent)%")
            .font(PocketStyle.font(.semibold, 13))
            .monospacedDigit()
        }
        .foregroundStyle(PocketStyle.batteryColor(state.batteryPercent))
      }
    }
  }

  private var batterySymbol: String {
    switch state.batteryPercent {
    case ..<13: return "battery.0percent"
    case ..<38: return "battery.25percent"
    case ..<63: return "battery.50percent"
    case ..<88: return "battery.75percent"
    default: return "battery.100percent"
    }
  }
}

/// Record/Stop and Disconnect, through App Intents that run in the app process.
struct PocketActionButtons: View {
  let state: PocketLiveActivityAttributes.ContentState

  var body: some View {
    HStack(spacing: 8) {
      Button(intent: PocketSetRecordingIntent(value: !state.recording)) {
        HStack(spacing: 6) {
          if state.recording {
            RoundedRectangle(cornerRadius: 2.5, style: .continuous)
              .fill(Color.white)
              .frame(width: 10, height: 10)
          } else {
            Circle().fill(Color.white).frame(width: 10, height: 10)
          }
          Text(state.recording ? "Stop" : "Record")
            .font(PocketStyle.font(.semibold, 14))
        }
        .foregroundStyle(Color.white)
        .frame(maxWidth: .infinity, minHeight: 40)
        .background(PocketStyle.recordRed, in: Capsule())
      }
      .buttonStyle(.plain)
      .disabled(state.phase != "live")

      Button(intent: PocketDisconnectIntent()) {
        Text("Disconnect")
          .font(PocketStyle.font(.semibold, 14))
          .foregroundStyle(PocketStyle.foreground)
          .frame(maxWidth: .infinity, minHeight: 40)
          .background(PocketStyle.surfaceStrong, in: Capsule())
      }
      .buttonStyle(.plain)
    }
  }
}

struct PocketStaleNote: View {
  var body: some View {
    Text("Open Pocket Monitor to reconnect")
      .font(PocketStyle.font(.medium, 13))
      .foregroundStyle(PocketStyle.muted)
      .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
  }
}
