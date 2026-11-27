import SwiftUI

/// Sondr look for the Lock Screen and Dynamic Island (pocket-ui palette, SN Pro bundled in Fonts/).
enum PocketStyle {
  /// The app's dark page and tile (`background` dark / the logo tile).
  static let tile = Color(red: 0x12 / 255, green: 0x12 / 255, blue: 0x12 / 255)
  static let surface = Color(red: 0x1a / 255, green: 0x1a / 255, blue: 0x1a / 255)
  static let surfaceStrong = Color(white: 1, opacity: 0.12)
  static let foreground = Color(red: 0xf4 / 255, green: 0xf4 / 255, blue: 0xf4 / 255)
  static let muted = Color(red: 0x8b / 255, green: 0x8b / 255, blue: 0x8b / 255)
  /// Recording (`dotPink`).
  static let dotPink = Color(red: 0xd6 / 255, green: 0x15 / 255, blue: 0x5f / 255)
  /// The logo's record dot.
  static let logoRed = Color(red: 0xe5 / 255, green: 0x27 / 255, blue: 0x3a / 255)
  static let success = Color(red: 0x22 / 255, green: 0xc5 / 255, blue: 0x5e / 255)
  static let warning = Color(red: 0xfb / 255, green: 0xbf / 255, blue: 0x24 / 255)
  static let destructive = Color(red: 0xef / 255, green: 0x44 / 255, blue: 0x44 / 255)

  static let liveURL = URL(string: "pocketmonitor://live")

  // VERIFY: the extension registers SN Pro from UIAppFonts (PostScript names below); if not, SwiftUI
  // falls back to the system font silently.
  static func font(_ weight: Font.Weight, _ size: CGFloat) -> Font {
    let name: String
    switch weight {
    case .bold, .heavy, .black: name = "SNPro-Bold"
    case .semibold: name = "SNPro-SemiBold"
    default: name = "SNPro-Medium"
    }
    return Font.custom(name, size: size)
  }

  static func linkColor(_ band: String) -> Color {
    switch band {
    case "poor": return destructive
    case "watch": return warning
    default: return success
    }
  }

  static func batteryColor(_ percent: Int) -> Color {
    percent >= 0 && percent <= 15 ? destructive : percent <= 30 ? warning : foreground
  }

  /// "1h 23m", "42m", "—".
  static func remaining(_ seconds: Int) -> String {
    guard seconds >= 0 else { return "—" }
    let minutes = seconds / 60
    if minutes >= 60 { return "\(minutes / 60)h \(String(format: "%02d", minutes % 60))m" }
    return "\(minutes)m"
  }
}

/// The Pocket Monitor mark (src/components/app-logo.tsx): a white viewfinder ring around a red
/// record dot on a dark continuous-corner tile, drawn on the 256-unit grid of the original.
struct PocketLogoMark: View {
  var size: CGFloat = 24
  var tile = true

  var body: some View {
    let unit = size / 256
    ZStack {
      if tile {
        RoundedRectangle(cornerRadius: 56 * unit, style: .continuous).fill(PocketStyle.tile)
      }
      Circle()
        .strokeBorder(Color.white, lineWidth: 10 * unit)
        .frame(width: (78 * 2 + 10) * unit, height: (78 * 2 + 10) * unit)
      Circle()
        .fill(PocketStyle.logoRed)
        .frame(width: 104 * unit, height: 104 * unit)
    }
    .frame(width: size, height: size)
    .accessibilityLabel("Pocket Monitor")
  }
}

/// The REC dot: dotPink while recording, white at standby.
struct PocketRecDot: View {
  var recording: Bool
  var size: CGFloat = 8

  var body: some View {
    Circle()
      .fill(recording ? PocketStyle.dotPink : PocketStyle.foreground.opacity(0.85))
      .frame(width: size, height: size)
  }
}

/// Four link bars in the link-health colour.
struct PocketLinkBars: View {
  var bars: Int
  var band: String
  var height: CGFloat = 12

  var body: some View {
    HStack(alignment: .bottom, spacing: 2) {
      ForEach(0..<4, id: \.self) { i in
        RoundedRectangle(cornerRadius: 1, style: .continuous)
          .fill(i < bars ? PocketStyle.linkColor(band) : PocketStyle.surfaceStrong)
          .frame(width: 3, height: height * CGFloat(i + 1) / 4)
      }
    }
    .frame(height: height, alignment: .bottom)
    .accessibilityLabel("Link \(band)")
  }
}
