import ExpoModulesCore
import Foundation

@Record
struct OpcBleConnectOptions {
  var service: String
  var writeCharacteristic: String
  var notifyCharacteristics: [String]
  /// DJI app-pairing arm: `[01 00]` with response to `notifyCharacteristics[0]` once every CCCD
  /// settled. `connect` resolves after it lands. Default on (every DJI camera needs it).
  var armPairing: Bool = true
}

@Record
struct OpcBlePowerEvent {
  var state: String
}

@Record
struct OpcBleAdvertEvent {
  var id: String
  var name: String?
  var rssi: Int
  var manufacturerData: Data?
  var serviceUuids: [String]
}

@Record
struct OpcBleConnectionEvent {
  var id: String
  var state: String
  var error: String?
}

@Record
struct OpcBleNotifyEvent {
  var id: String
  var characteristic: String
  var bytes: Data
}

final class OpcBluetoothException: Exception, @unchecked Sendable {
  private let text: String
  private let errCode: String
  init(code: String, _ text: String) {
    self.text = text
    self.errCode = code
    super.init()
  }
  override var reason: String { text }
  override var code: String { errCode }

  static func from(_ error: Error) -> OpcBluetoothException {
    if let e = error as? OpcBleError { return OpcBluetoothException(code: e.code, e.text) }
    return OpcBluetoothException(code: "ERR_BLE", error.localizedDescription)
  }
}

/// JS module `OpcBluetooth` (see `src/types.ts` `OpcBluetoothNativeModule`).
/// Needs `NSBluetoothAlwaysUsageDescription` in Info.plist (app.json / config plugin).
@ExpoModule("OpcBluetooth")
public final class OpcBluetoothModule: Module, OpcBleCentralDelegate {
  /// Created on first use (from the JS thread) with its delegate already set, so the BLE queue
  /// never observes a nil delegate.
  private lazy var central: OpcBleCentral = {
    let c = OpcBleCentral()
    c.delegate = self
    return c
  }()

  @Event("onPowerState")
  var onPowerState: (OpcBlePowerEvent) -> Void

  @Event("onAdvert")
  var onAdvert: (OpcBleAdvertEvent) -> Void

  @Event("onConnection")
  var onConnection: (OpcBleConnectionEvent) -> Void

  @Event("onNotify")
  var onNotify: (OpcBleNotifyEvent) -> Void

  @JS
  func getPowerState() -> String {
    central.powerState()
  }

  @JS
  func requestPermissions() async -> Bool {
    let c = central
    return await withCheckedContinuation { (k: CheckedContinuation<Bool, Never>) in
      c.requestPermission { k.resume(returning: $0) }
    }
  }

  @JS
  func startScan(serviceUuids: [String]?) {
    central.startScan(services: serviceUuids)
  }

  @JS
  func stopScan() {
    central.stopScan()
  }

  @JS
  func connect(id: String, options: OpcBleConnectOptions) async throws {
    let c = central
    do {
      try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
        c.connect(
          id: id, service: options.service, write: options.writeCharacteristic,
          notify: options.notifyCharacteristics, armPairing: options.armPairing
        ) { error in
          if let error { k.resume(throwing: error) } else { k.resume() }
        }
      }
    } catch {
      throw OpcBluetoothException.from(error)
    }
  }

  @JS
  func disconnect(id: String) async {
    let c = central
    await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
      c.disconnect(id: id) { k.resume() }
    }
  }

  @JS
  func write(id: String, bytes: Data, withResponse: Bool) async throws {
    let c = central
    do {
      try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
        c.write(id: id, bytes: bytes, withResponse: withResponse) { error in
          if let error { k.resume(throwing: error) } else { k.resume() }
        }
      }
    } catch {
      throw OpcBluetoothException.from(error)
    }
  }

  // MARK: - OpcBleCentralDelegate (BLE queue)

  func blePowerStateChanged(_ state: String) {
    onPowerState(OpcBlePowerEvent(state: state))
  }

  func bleDiscovered(id: String, name: String?, rssi: Int, manufacturerData: Data?, serviceUuids: [String]) {
    onAdvert(
      OpcBleAdvertEvent(
        id: id, name: name, rssi: rssi, manufacturerData: manufacturerData, serviceUuids: serviceUuids))
  }

  func bleConnectionChanged(id: String, state: String, error: String?) {
    onConnection(OpcBleConnectionEvent(id: id, state: state, error: error))
  }

  func bleNotified(id: String, characteristic: String, bytes: Data) {
    onNotify(OpcBleNotifyEvent(id: id, characteristic: characteristic, bytes: bytes))
  }
}
