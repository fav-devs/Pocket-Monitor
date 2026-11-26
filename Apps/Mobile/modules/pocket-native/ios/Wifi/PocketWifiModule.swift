import ExpoModulesCore
import Foundation
import NetworkExtension

@Record
struct PocketWifiJoinOptions {
  var joinOnce: Bool = true
  var timeoutMs: Double = 20_000
}

@Record
struct PocketWifiJoinResult {
  var joined: Bool
  var outcome: String
  var message: String?
}

/// JS module `PocketWifi` (see `src/types.ts` `PocketWifiNativeModule`), ported from upstream
/// `DjiAppleWiFiJoiner`.
///
/// Needs the `com.apple.developer.networking.HotspotConfiguration` entitlement (join) and
/// `com.apple.developer.networking.wifi-info` (SSID read), set through app.json / a config plugin.
/// `NEHotspotNetwork.fetchCurrent` returns the SSID of networks this app configured without
/// location permission; other networks need location authorization.
///
/// `apply` success is not "associated with an address": first join is prompt + associate + DHCP,
/// and a wrong passphrase also returns success (iOS then fails silently). So a join only counts as
/// `joined` once the phone holds a `192.168.2.2…254` address or reports the target SSID.
@ExpoModule("PocketWifi")
public final class PocketWifiModule: Module {
  private static func result(_ outcome: String, _ joined: Bool, _ message: String? = nil) -> PocketWifiJoinResult {
    PocketWifiJoinResult(joined: joined, outcome: outcome, message: message)
  }

  @JS
  func join(ssid: String, password: String, options: PocketWifiJoinOptions) async -> PocketWifiJoinResult {
    if PocketNetworkInterfaces.isSimulator {
      return Self.result("failed", false, "the simulator has no camera Wi-Fi")
    }
    let timeout = max(1_000, options.timeoutMs) / 1_000
    let deadline = Date().addingTimeInterval(timeout)

    // Applying again (join-once from an earlier pairing) asks "Wants to Join" for the network the
    // phone is already on.
    if await Self.fetchSSID() == ssid, PocketNetworkInterfaces.cameraAddress() != nil {
      return Self.result("already-associated", true)
    }

    let config: NEHotspotConfiguration =
      password.isEmpty
      ? NEHotspotConfiguration(ssid: ssid)
      : NEHotspotConfiguration(ssid: ssid, passphrase: password, isWEP: false)
    // Join-once drops the hotspot when the app leaves the foreground; saved cameras need the
    // configuration to survive Control Center / background.
    config.joinOnce = options.joinOnce

    let applied: NSError?? = await withCheckedContinuation { (k: CheckedContinuation<NSError??, Never>) in
      let once = PocketOnce()
      NEHotspotConfigurationManager.shared.apply(config) { error in
        guard once.claim() else { return }
        k.resume(returning: .some(error as NSError?))
      }
      // iOS has not answered: "Wants to Join" may still be up.
      DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
        guard once.claim() else { return }
        k.resume(returning: .none)
      }
    }
    guard case .some(let error) = applied else {
      return Self.result("timeout", false, "the system did not answer the join request")
    }
    var alreadyAssociated = false
    if let error {
      if error.domain == NEHotspotConfigurationErrorDomain,
        let code = NEHotspotConfigurationError(rawValue: error.code)
      {
        switch code {
        case .alreadyAssociated:
          alreadyAssociated = true
        case .userDenied:
          return Self.result("user-denied", false, "join the camera Wi-Fi network to continue")
        case .invalidSSID, .invalidSSIDPrefix:
          return Self.result("not-found", false, "the network name was rejected (code \(error.code))")
        case .invalidWPAPassphrase, .invalidWEPPassphrase:
          return Self.result("wrong-password", false, "the Wi-Fi password was rejected (code \(error.code))")
        case .pending:
          return Self.result("timeout", false, "an earlier join request is still pending")
        default:
          return Self.result("failed", false, "the system refused the request (code \(error.code))")
        }
      } else {
        return Self.result("failed", false, "the system refused the request (\(error.domain) \(error.code))")
      }
    }

    // Wait for DHCP on the camera AP (or the SSID, for a non-SoftAP network).
    while Date() < deadline {
      if PocketNetworkInterfaces.cameraAddress() != nil {
        // Settle once: a just-associated address can flap.
        try? await Task.sleep(nanoseconds: 200_000_000)
        if PocketNetworkInterfaces.cameraAddress() != nil {
          return Self.result(alreadyAssociated ? "already-associated" : "joined", true)
        }
      }
      if await Self.fetchSSID() == ssid {
        return Self.result(alreadyAssociated ? "already-associated" : "joined", true)
      }
      try? await Task.sleep(nanoseconds: 250_000_000)
    }
    // A wrong or regenerated passphrase also ends here: iOS applies, then silently fails to join.
    return Self.result(
      "timeout", false, "applied, but the phone never joined (wrong password, or the camera AP is not up yet)")
  }

  @JS
  func leave(ssid: String) async {
    NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
  }

  @JS
  func currentSsid() async -> String? {
    await Self.fetchSSID()
  }

  @JS
  func localAddress() async -> String? {
    PocketNetworkInterfaces.cameraAddress()?.ipv4
  }

  /// `NEHotspotNetwork.fetchCurrent`, capped at 3 s (it can fail to call back).
  static func fetchSSID() async -> String? {
    if PocketNetworkInterfaces.isSimulator { return nil }
    return await withCheckedContinuation { (k: CheckedContinuation<String?, Never>) in
      let once = PocketOnce()
      NEHotspotNetwork.fetchCurrent { network in
        guard once.claim() else { return }
        k.resume(returning: network?.ssid)
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
        guard once.claim() else { return }
        k.resume(returning: nil)
      }
    }
  }
}
