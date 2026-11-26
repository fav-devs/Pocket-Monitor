@preconcurrency import CoreBluetooth
import Foundation
import os

protocol PocketBleCentralDelegate: AnyObject {
  func blePowerStateChanged(_ state: String)
  func bleDiscovered(id: String, name: String?, rssi: Int, manufacturerData: Data?, serviceUuids: [String])
  func bleConnectionChanged(id: String, state: String, error: String?)
  func bleNotified(id: String, characteristic: String, bytes: Data)
}

struct PocketBleError: LocalizedError {
  let code: String
  let text: String
  var errorDescription: String? { text }
}

/// CoreBluetooth side of the connection spine, ported from upstream `DjiAppleBluetoothLink`:
/// scan (unfiltered by default — Pocket 3 omits manufacturer data), connect, discover the DUML
/// service, enable notify on each requested characteristic, wait for every CCCD to settle, then
/// optionally write the DJI app-pairing arm `[01 00]` (with response) to the first notify
/// characteristic. `connect` resolves only after that write completes.
///
/// Threading: the manager runs on a private serial queue `pocket.ble`; all state below lives there.
/// JS calls hop onto it. Without-response writes are paced 120 ms apart (back-to-back writes to
/// fff5 drop, the same constraint Osmosis hit on Android).
final class PocketBleCentral: NSObject, @unchecked Sendable {
  static let pacingInterval: TimeInterval = 0.12
  static let connectDeadline: TimeInterval = 10
  /// DJI DUML service, used to surface cameras iOS already holds when the scan has no filter.
  static let djiService = CBUUID(string: "FFF0")

  weak var delegate: PocketBleCentralDelegate?
  private let q = DispatchQueue(label: "pocket.ble", qos: .userInitiated)
  private let log = Logger(subsystem: "pocket-native", category: "ble")
  private var central: CBCentralManager?
  private var peripherals: [UUID: CBPeripheral] = [:]
  private var lastAdvert: [UUID: (name: String?, mfr: Data?, at: TimeInterval)] = [:]
  private var scanServices: [CBUUID]??  // .none = not scanning; .some(nil) = unfiltered
  private var powerWaiters: [@Sendable (Bool) -> Void] = []
  private var links: [UUID: Link] = [:]
  private var disconnectWaiters: [UUID: [@Sendable () -> Void]] = [:]

  private final class Link: @unchecked Sendable {
    let peripheral: CBPeripheral
    let service: CBUUID
    let writeUUID: CBUUID
    let notifyUUIDs: [CBUUID]
    let armPairing: Bool
    var writeChar: CBCharacteristic?
    var notifyChars: [CBUUID: CBCharacteristic] = [:]
    var pendingNotify: Set<CBUUID> = []
    var connectDone: (@Sendable (Error?) -> Void)?
    var timeout: DispatchWorkItem?
    var ready = false
    var armPending = false
    var writes: [(bytes: Data, withResponse: Bool, done: @Sendable (Error?) -> Void)] = []
    var writing = false
    var awaitingResponse: (@Sendable (Error?) -> Void)?
    var awaitingWriteWithoutResponseSlot = false

    init(peripheral: CBPeripheral, service: CBUUID, write: CBUUID, notify: [CBUUID], arm: Bool) {
      self.peripheral = peripheral
      self.service = service
      self.writeUUID = write
      self.notifyUUIDs = notify
      self.armPairing = arm
    }
  }

  // MARK: - Helpers

  /// CoreBluetooth prints SIG-base UUIDs short (`FFF4`); JS always sees the full 128-bit form.
  static func fullUUID(_ u: CBUUID) -> String {
    let s = u.uuidString.uppercased()
    switch s.count {
    case 4: return "0000\(s)-0000-1000-8000-00805F9B34FB"
    case 8: return "\(s)-0000-1000-8000-00805F9B34FB"
    default: return s
    }
  }

  /// `CBUUID(string:)` raises an Objective-C exception on malformed input; validate first.
  static func parseUUID(_ s: String) -> CBUUID? {
    let t = s.trimmingCharacters(in: .whitespaces)
    let hex = CharacterSet(charactersIn: "0123456789abcdefABCDEF")
    if t.count == 4 || t.count == 8, t.unicodeScalars.allSatisfy({ hex.contains($0) }) {
      return CBUUID(string: t)
    }
    return UUID(uuidString: t) != nil ? CBUUID(string: t) : nil
  }

  static func powerName(_ state: CBManagerState) -> String {
    switch state {
    case .unknown: return "unknown"
    case .resetting: return "resetting"
    case .unsupported: return "unsupported"
    case .unauthorized: return "unauthorized"
    case .poweredOff: return "off"
    case .poweredOn: return "on"
    @unknown default: return "unknown"
    }
  }

  /// Must run on `q`. Creating the manager is what shows the system Bluetooth prompt.
  private func ensureCentral() -> CBCentralManager {
    if let central { return central }
    let c = CBCentralManager(
      delegate: self, queue: q, options: [CBCentralManagerOptionShowPowerAlertKey: false])
    central = c
    return c
  }

  // MARK: - Power / permission

  func powerState() -> String {
    switch CBManager.authorization {
    case .denied, .restricted: return "unauthorized"
    case .notDetermined: return "unknown"  // do not prompt from a getter
    default: break
    }
    return q.sync { Self.powerName(ensureCentral().state) }
  }

  func requestPermission(_ done: @escaping @Sendable (Bool) -> Void) {
    q.async {
      let c = self.ensureCentral()
      if CBManager.authorization != .notDetermined, c.state != .unknown {
        return done(CBManager.authorization == .allowedAlways)
      }
      self.powerWaiters.append(done)
      // The system prompt can stay up a long time; answer with whatever is known after 60 s.
      self.q.asyncAfter(deadline: .now() + 60) {
        guard !self.powerWaiters.isEmpty else { return }
        let waiters = self.powerWaiters
        self.powerWaiters.removeAll()
        let ok = CBManager.authorization == .allowedAlways
        waiters.forEach { $0(ok) }
      }
    }
  }

  // MARK: - Scan

  func startScan(services: [String]?) {
    q.async {
      let c = self.ensureCentral()
      let parsed = services?.compactMap(Self.parseUUID)
      let filter = (parsed?.isEmpty ?? true) ? nil : parsed
      self.scanServices = .some(filter)
      self.peripherals = self.peripherals.filter { self.links[$0.key] != nil }
      self.lastAdvert.removeAll()
      if c.state == .poweredOn { self.beginScan(c, filter) }  // else on poweredOn
    }
  }

  private func beginScan(_ c: CBCentralManager, _ filter: [CBUUID]?) {
    // Duplicates on: the first advert is often nameless; later ones add the name / model.
    c.scanForPeripherals(withServices: filter, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    // Cameras iOS already holds (previous session) never advertise to us; surface them now.
    for p in c.retrieveConnectedPeripherals(withServices: filter ?? [Self.djiService]) {
      peripherals[p.identifier] = p
      delegate?.bleDiscovered(
        id: p.identifier.uuidString, name: p.name, rssi: 127, manufacturerData: nil,
        serviceUuids: (filter ?? [Self.djiService]).map(Self.fullUUID))
    }
  }

  func stopScan() {
    q.async {
      self.scanServices = .none
      self.central?.stopScan()
    }
  }

  // MARK: - Connect

  func connect(
    id: String, service: String, write: String, notify: [String], armPairing: Bool,
    done: @escaping @Sendable (Error?) -> Void
  ) {
    q.async {
      guard let uuid = UUID(uuidString: id) else {
        return done(PocketBleError(code: "ERR_BLE_ID", text: "not a peripheral id: \(id)"))
      }
      let c = self.ensureCentral()
      guard c.state == .poweredOn else {
        return done(PocketBleError(code: "ERR_BLE_POWER", text: "Bluetooth is \(Self.powerName(c.state))"))
      }
      guard let p = self.peripherals[uuid] ?? c.retrievePeripherals(withIdentifiers: [uuid]).first else {
        return done(PocketBleError(code: "ERR_BLE_GONE", text: "camera disappeared"))
      }
      if let old = self.links[uuid] {
        if old.ready, old.peripheral.state == .connected { return done(nil) }
        self.fail(old, PocketBleError(code: "ERR_BLE_SUPERSEDED", text: "superseded by a new connect"), cancel: false)
      }
      let notifyUUIDs = notify.compactMap(Self.parseUUID)
      guard let serviceUUID = Self.parseUUID(service), let writeUUID = Self.parseUUID(write),
        notifyUUIDs.count == notify.count
      else {
        return done(PocketBleError(code: "ERR_BLE_ARGS", text: "malformed service or characteristic UUID"))
      }
      let link = Link(peripheral: p, service: serviceUUID, write: writeUUID, notify: notifyUUIDs, arm: armPairing)
      link.connectDone = done
      self.links[uuid] = link
      self.peripherals[uuid] = p
      p.delegate = self
      self.delegate?.bleConnectionChanged(id: id, state: "connecting", error: nil)
      // iOS `connect` has no deadline and can sit ~30 s; a good handshake takes 1–3 s.
      let work = DispatchWorkItem { [weak self, weak link] in
        guard let self, let link, link.connectDone != nil else { return }
        self.fail(link, PocketBleError(code: "ERR_BLE_TIMEOUT", text: "Bluetooth connect timed out"), cancel: true)
      }
      link.timeout = work
      self.q.asyncAfter(deadline: .now() + Self.connectDeadline, execute: work)
      c.connect(p, options: nil)
    }
  }

  func disconnect(id: String, done: @escaping @Sendable () -> Void) {
    q.async {
      guard let uuid = UUID(uuidString: id), let link = self.links[uuid] else { return done() }
      self.disconnectWaiters[uuid, default: []].append(done)
      self.fail(link, PocketBleError(code: "ERR_BLE_DISCONNECTED", text: "disconnected"), cancel: true, report: false)
      self.delegate?.bleConnectionChanged(id: id, state: "disconnected", error: nil)
      // A camera that never reports the drop must not hold the caller forever.
      self.q.asyncAfter(deadline: .now() + 3) { self.resumeDisconnectWaiters(uuid) }
    }
  }

  private func resumeDisconnectWaiters(_ uuid: UUID) {
    let waiting = disconnectWaiters.removeValue(forKey: uuid) ?? []
    waiting.forEach { $0() }
  }

  /// Ends a link: rejects the connect and pending writes, optionally cancels the connection.
  private func fail(_ link: Link, _ error: Error, cancel: Bool, report: Bool = true) {
    link.timeout?.cancel()
    link.timeout = nil
    let id = link.peripheral.identifier
    let wasConnecting = link.connectDone != nil
    if let done = link.connectDone {
      link.connectDone = nil
      done(error)
    }
    link.awaitingResponse?(error)
    link.awaitingResponse = nil
    for w in link.writes { w.done(error) }
    link.writes.removeAll()
    link.ready = false
    if links[id] === link { links.removeValue(forKey: id) }
    if cancel { central?.cancelPeripheralConnection(link.peripheral) }
    if report {
      delegate?.bleConnectionChanged(
        id: id.uuidString, state: wasConnecting ? "failed" : "disconnected", error: error.localizedDescription)
    }
  }

  private func finishConnect(_ link: Link) {
    link.timeout?.cancel()
    link.timeout = nil
    link.ready = true
    let done = link.connectDone
    link.connectDone = nil
    delegate?.bleConnectionChanged(id: link.peripheral.identifier.uuidString, state: "connected", error: nil)
    done?(nil)
  }

  /// All CCCD callbacks settled (success or not — a missing CCCD must not hang the connect).
  private func afterNotifySettled(_ link: Link) {
    guard link.connectDone != nil, link.pendingNotify.isEmpty, !link.armPending else { return }
    guard link.armPairing, let first = link.notifyUUIDs.first else { return finishConnect(link) }
    guard let armChar = link.notifyChars[first], armChar.isNotifying else {
      return fail(
        link, PocketBleError(code: "ERR_BLE_NOTIFY", text: "notify did not enable on \(Self.fullUUID(first))"),
        cancel: true)
    }
    link.armPending = true
    link.peripheral.writeValue(Data([0x01, 0x00]), for: armChar, type: .withResponse)
  }

  // MARK: - Write

  func write(id: String, bytes: Data, withResponse: Bool, done: @escaping @Sendable (Error?) -> Void) {
    q.async {
      guard let uuid = UUID(uuidString: id), let link = self.links[uuid], link.ready, link.writeChar != nil else {
        return done(PocketBleError(code: "ERR_BLE_NOT_CONNECTED", text: "not connected"))
      }
      link.writes.append((bytes, withResponse, done))
      self.pump(link)
    }
  }

  private func pump(_ link: Link) {
    guard !link.writing, !link.writes.isEmpty, link.ready, let ch = link.writeChar else { return }
    let p = link.peripheral
    let next = link.writes[0]
    if next.withResponse {
      link.writes.removeFirst()
      link.writing = true
      link.awaitingResponse = next.done
      p.writeValue(next.bytes, for: ch, type: .withResponse)
      return
    }
    guard p.canSendWriteWithoutResponse else {
      link.awaitingWriteWithoutResponseSlot = true  // resumes in peripheralIsReady
      return
    }
    link.writes.removeFirst()
    link.writing = true
    p.writeValue(next.bytes, for: ch, type: .withoutResponse)
    next.done(nil)
    q.asyncAfter(deadline: .now() + Self.pacingInterval) { [weak self, weak link] in
      guard let self, let link else { return }
      link.writing = false
      self.pump(link)
    }
  }

  private func link(for p: CBPeripheral) -> Link? {
    guard let link = links[p.identifier], link.peripheral === p else { return nil }
    return link
  }
}

// MARK: - CBCentralManagerDelegate (on q)

extension PocketBleCentral: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    delegate?.blePowerStateChanged(Self.powerName(central.state))
    if central.state != .unknown, central.state != .resetting, !powerWaiters.isEmpty {
      let waiters = powerWaiters
      powerWaiters.removeAll()
      let ok = CBManager.authorization == .allowedAlways
      waiters.forEach { $0(ok) }
    }
    if central.state == .poweredOn, case .some(let filter) = scanServices {
      beginScan(central, filter)
    }
    if central.state != .poweredOn {
      for link in Array(links.values) {
        fail(link, PocketBleError(code: "ERR_BLE_POWER", text: "Bluetooth is \(Self.powerName(central.state))"), cancel: false)
      }
    }
  }

  func centralManager(
    _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any], rssi RSSI: NSNumber
  ) {
    let id = peripheral.identifier
    peripherals[id] = peripheral
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name
    let mfr = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data
    // Duplicates arrive many times a second per device. Forward changes, else ~1 Hz per device.
    let now = ProcessInfo.processInfo.systemUptime
    if let last = lastAdvert[id], last.name == name, last.mfr == mfr, now - last.at < 1 { return }
    lastAdvert[id] = (name, mfr, now)
    let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
    delegate?.bleDiscovered(
      id: id.uuidString, name: name, rssi: RSSI.intValue, manufacturerData: mfr,
      serviceUuids: services.map(Self.fullUUID))
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard let link = link(for: peripheral) else {
      central.cancelPeripheralConnection(peripheral)  // a foreign or abandoned link
      return
    }
    peripheral.discoverServices([link.service])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    guard let link = link(for: peripheral) else { return }
    fail(link, error ?? PocketBleError(code: "ERR_BLE_CONNECT", text: "connect failed"), cancel: false)
  }

  func centralManager(
    _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
  ) {
    resumeDisconnectWaiters(peripheral.identifier)
    guard let link = link(for: peripheral) else { return }
    fail(link, error ?? PocketBleError(code: "ERR_BLE_DISCONNECTED", text: "the camera disconnected"), cancel: false)
  }
}

// MARK: - CBPeripheralDelegate (on q)

extension PocketBleCentral: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard let link = link(for: peripheral), link.connectDone != nil else { return }
    if let error { return fail(link, error, cancel: true) }
    guard let svc = peripheral.services?.first(where: { $0.uuid == link.service }) else {
      return fail(link, PocketBleError(code: "ERR_BLE_NO_SERVICE", text: "camera has no DUML service"), cancel: true)
    }
    peripheral.discoverCharacteristics([link.writeUUID] + link.notifyUUIDs, for: svc)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
  ) {
    guard let link = link(for: peripheral), link.connectDone != nil, service.uuid == link.service else { return }
    if let error { return fail(link, error, cancel: true) }
    for c in service.characteristics ?? [] {
      if c.uuid == link.writeUUID { link.writeChar = c }
      if link.notifyUUIDs.contains(c.uuid) { link.notifyChars[c.uuid] = c }
    }
    guard link.writeChar != nil else {
      return fail(link, PocketBleError(code: "ERR_BLE_NO_SERVICE", text: "write characteristic missing"), cancel: true)
    }
    for uuid in link.notifyUUIDs {
      guard let c = link.notifyChars[uuid] else { continue }
      // `setNotifyValue` never calls back when the char has neither notify nor indicate.
      if c.properties.contains(.notify) || c.properties.contains(.indicate) {
        link.pendingNotify.insert(uuid)
        peripheral.setNotifyValue(true, for: c)
      }
    }
    afterNotifySettled(link)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard let link = link(for: peripheral) else { return }
    if let error {
      log.info("ble: notify \(Self.fullUUID(characteristic.uuid), privacy: .public) failed \(error.localizedDescription, privacy: .public)")
    }
    link.pendingNotify.remove(characteristic.uuid)
    afterNotifySettled(link)
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    guard let link = link(for: peripheral) else { return }
    if link.armPending, link.notifyUUIDs.first == characteristic.uuid, link.connectDone != nil {
      link.armPending = false
      if let error { return fail(link, error, cancel: true) }
      return finishConnect(link)
    }
    if characteristic.uuid == link.writeUUID, let done = link.awaitingResponse {
      link.awaitingResponse = nil
      link.writing = false
      done(error)
      pump(link)
    }
  }

  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    guard let link = link(for: peripheral), link.awaitingWriteWithoutResponseSlot else { return }
    link.awaitingWriteWithoutResponseSlot = false
    pump(link)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard error == nil, let value = characteristic.value, !value.isEmpty else { return }
    delegate?.bleNotified(
      id: peripheral.identifier.uuidString, characteristic: Self.fullUUID(characteristic.uuid), bytes: value)
  }
}
