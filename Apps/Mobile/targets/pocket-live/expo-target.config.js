/**
 * Widget extension: the Pocket Monitor Live Activity (Lock Screen + Dynamic Island) and the iOS 18
 * record control (Control Center / Lock Screen / Action button). Linked at prebuild by
 * @bacons/apple-targets (CNG: never edit ios/ by hand).
 *
 * - Every file in this folder is part of the extension; `_shared/*` is also compiled into the main
 *   app (the App Intents must live in the app so LiveActivityIntent.perform runs in the app process).
 * - `Fonts/*.ttf` are copied from @expo-google-fonts/sn-pro at prebuild by
 *   plugins/with-live-activity-fonts.js (not committed) and registered in Info.plist `UIAppFonts`.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'widget',
  name: 'PocketLive',
  displayName: 'Pocket Monitor',
  bundleIdentifier: '.live',
  // Interactive Live Activity buttons need iOS 17; the control is gated to iOS 18 in Swift.
  deploymentTarget: '17.0',
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
});
