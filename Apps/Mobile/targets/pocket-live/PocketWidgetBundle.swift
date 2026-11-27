import SwiftUI
import WidgetKit

// VERIFY: `if #available` in the bundle (WidgetBundleBuilder limited availability) builds with the
// iOS 17 deployment target and the control appears in Control Center on iOS 18.
@main
struct PocketWidgetBundle: WidgetBundle {
  var body: some Widget {
    PocketLiveActivityWidget()
    if #available(iOS 18.0, *) {
      PocketRecordControl()
    }
  }
}
