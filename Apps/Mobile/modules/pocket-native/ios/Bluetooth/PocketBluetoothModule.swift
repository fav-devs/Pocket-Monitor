import ExpoModulesCore
import Foundation

@Record
struct PocketBleConnectOptions {
  var service: String
  var writeCharacteristic: String
  var notifyCharacteristics: [String]
  /// DJI app-pairing arm: `[01 00]` with response to `notifyCharacteristics[0]` once every CCCD
  /// settled. `connect` resolves after it lands. Default on (every DJI camera needs it).
  var armPairing: Bool = true
}

@Record
struct PocketBlePowerEvent {
  var state: String
}

@Record
struct PocketBleAdvertEvent {
  var id: String
  var name: String?
  var rssi: Int
  var manufacturerData: Data?
  var serviceUuids: [String]
}

@Record
struct PocketBleConnectionEvent {
  var id: String
  var state: String
  var error: String?
}

@Record
struct PocketBleNotifyEvent {
  var id: String
  var characteristic: String
  var bytes: Data
}

final class PocketBluetoothException: Exception, @unchecked Sendable {
  private let text: String
  private let errCode: String
  init(code: String, _ text: String) {
    self.text = text
    self.errCode = code
    super.init()
  }
  override var reason: String { text }
  override var code: String { errCode }

  static func from(_ error: Error) -> PocketBluetoothException {
    if let e = error as? PocketBleError { return PocketBluetoothException(code: e.code, e.text) }
    return PocketBluetoothException(code: "ERR_BLE", error.localizedDescription)
  }
}

/// JS module `PocketBluetooth` (see `src/types.ts` `PocketBluetoothNativeModule`).
/// Needs `NSBluetoothAlwaysUsageDescription` in Info.plist (app.json / config plugin).
@ExpoModule("PocketBluetooth")
public final class PocketBluetoothModule: Module, PocketBleCentralDelegate {
  /// Created on first use (from the JS thread) with its delegate already set, so the BLE queue
  /// never observes a nil delegate.
  private lazy var central: PocketBleCentral = {
    let c = PocketBleCentral()
    c.delegate = self
    return c
  }()

  @Event("onPowerState")
  var onPowerState: (PocketBlePowerEvent) -> Void

  @Event("onAdvert")
  var onAdvert: (PocketBleAdvertEvent) -> Void

  @Event("onConnection")
  var onConnection: (PocketBleConnectionEvent) -> Void

  @Event("onNotify")
  var onNotify: (PocketBleNotifyEvent) -> Void

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
  func connect(id: String, options: PocketBleConnectOptions) async throws {
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
      throw PocketBluetoothException.from(error)
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
      throw PocketBluetoothException.from(error)
    }
  }

  // MARK: - PocketBleCentralDelegate (BLE queue)

  func blePowerStateChanged(_ state: String) {
    onPowerState(PocketBlePowerEvent(state: state))
  }

  func bleDiscovered(id: String, name: String?, rssi: Int, manufacturerData: Data?, serviceUuids: [String]) {
    onAdvert(
      PocketBleAdvertEvent(
        id: id, name: name, rssi: rssi, manufacturerData: manufacturerData, serviceUuids: serviceUuids))
  }

  func bleConnectionChanged(id: String, state: String, error: String?) {
    onConnection(PocketBleConnectionEvent(id: id, state: state, error: error))
  }

  func bleNotified(id: String, characteristic: String, bytes: Data) {
    onNotify(PocketBleNotifyEvent(id: id, characteristic: characteristic, bytes: bytes))
  }
}
