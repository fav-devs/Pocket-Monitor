import ExpoModulesCore
import Foundation
import GameController

@Record
struct OpcGamepadButtons: Equatable {
  var a: Bool = false
  var b: Bool = false
  var x: Bool = false
  var y: Bool = false
  var l1: Bool = false
  var r1: Bool = false
  var up: Bool = false
  var down: Bool = false
  var left: Bool = false
  var right: Bool = false
  var menu: Bool = false
}

@Record
struct OpcGamepadStateEvent: Equatable {
  var connected: Bool
  var name: String?
  var leftX: Double = 0
  var leftY: Double = 0
  var rightX: Double = 0
  var rightY: Double = 0
  var l2: Double = 0
  var r2: Double = 0
  var buttons: OpcGamepadButtons = OpcGamepadButtons()
}

/// Reads the first connected extended gamepad and emits `onGamepad` (`GamepadState`).
///
/// Everything runs on the main queue, as upstream `GimbalGamepadBridge` does (`handlerQueue = .main`),
/// with a value-changed closure that carries no actor isolation (upstream `GimbalGamepadCallback`:
/// an actor-isolated `valueChangedHandler` was a crash class). Element changes are coalesced and emitted at most ~60 Hz, only when the state changed;
/// connect/disconnect always emit. Axes follow GameController: stick up and right are positive.
@ExpoModule("OpcGamepad")
public final class OpcGamepadModule: Module {
  private let q = DispatchQueue.main
  // ---- on main ----
  private var running = false
  private var observers: [NSObjectProtocol] = []
  private weak var boundController: GCController?
  private var lastSent: OpcGamepadStateEvent?
  private var emitScheduled = false

  @Event("onGamepad")
  var onGamepad: (OpcGamepadStateEvent) -> Void

  @JS
  func start() {
    q.async {
      guard !self.running else { return }
      self.running = true
      let center = NotificationCenter.default
      let rebind: @Sendable (Notification) -> Void = { [weak self] _ in
        self?.q.async { self?.bind() }
      }
      self.observers = [
        center.addObserver(forName: .GCControllerDidConnect, object: nil, queue: nil, using: rebind),
        center.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: nil, using: rebind),
      ]
      // Keep reading while a sheet or another app-owned view is first responder.
      GCController.shouldMonitorBackgroundEvents = true
      self.bind()
    }
  }

  @JS
  func stop() {
    q.async { self.teardown() }
  }

  public override func willDestroy() {
    if Thread.isMainThread { teardown() } else { DispatchQueue.main.async { self.teardown() } }
  }

  private func teardown() {
    guard running else { return }
    running = false
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
    for c in GCController.controllers() { c.extendedGamepad?.valueChangedHandler = nil }
    boundController = nil
    lastSent = nil
  }

  /// On main. Binds the first controller with an extended profile.
  private func bind() {
    guard running else { return }
    for c in GCController.controllers() { c.extendedGamepad?.valueChangedHandler = nil }
    let controller = GCController.controllers().first { $0.extendedGamepad != nil }
    boundController = controller
    guard let controller, let pad = controller.extendedGamepad else {
      send(Self.disconnected, force: true)
      return
    }
    controller.handlerQueue = q
    pad.valueChangedHandler = Self.makeHandler { [weak self] in self?.scheduleEmit() }
    send(Self.snapshot(controller), force: true)
  }

  /// A nonisolated factory so the handler closure never inherits an actor from its context.
  private static func makeHandler(
    _ changed: @escaping @Sendable () -> Void
  ) -> GCExtendedGamepadValueChangedHandler {
    { _, _ in changed() }
  }

  /// On main. Coalesce bursts of element changes into one emit per ~16 ms.
  private func scheduleEmit() {
    guard running, !emitScheduled else { return }
    emitScheduled = true
    q.asyncAfter(deadline: .now() + .milliseconds(16)) { [weak self] in
      guard let self else { return }
      self.emitScheduled = false
      guard self.running, let controller = self.boundController, controller.extendedGamepad != nil else { return }
      self.send(Self.snapshot(controller), force: false)
    }
  }

  private func send(_ state: OpcGamepadStateEvent, force: Bool) {
    if !force, state == lastSent { return }
    lastSent = state
    onGamepad(state)
  }

  /// The macro's memberwise init has no defaults for non-optional fields; spell them out.
  private static let disconnected = OpcGamepadStateEvent(
    connected: false, name: nil, leftX: 0, leftY: 0, rightX: 0, rightY: 0, l2: 0, r2: 0,
    buttons: OpcGamepadButtons(
      a: false, b: false, x: false, y: false, l1: false, r1: false,
      up: false, down: false, left: false, right: false, menu: false))

  private static func snapshot(_ controller: GCController) -> OpcGamepadStateEvent {
    guard let pad = controller.extendedGamepad else {
      return Self.disconnected
    }
    let buttons = OpcGamepadButtons(
      a: pad.buttonA.isPressed, b: pad.buttonB.isPressed,
      x: pad.buttonX.isPressed, y: pad.buttonY.isPressed,
      l1: pad.leftShoulder.isPressed, r1: pad.rightShoulder.isPressed,
      up: pad.dpad.up.isPressed, down: pad.dpad.down.isPressed,
      left: pad.dpad.left.isPressed, right: pad.dpad.right.isPressed,
      menu: pad.buttonMenu.isPressed)
    return OpcGamepadStateEvent(
      connected: true,
      name: controller.vendorName ?? controller.productCategory,
      leftX: Double(pad.leftThumbstick.xAxis.value),
      leftY: Double(pad.leftThumbstick.yAxis.value),
      rightX: Double(pad.rightThumbstick.xAxis.value),
      rightY: Double(pad.rightThumbstick.yAxis.value),
      l2: Double(pad.leftTrigger.value),
      r2: Double(pad.rightTrigger.value),
      buttons: buttons)
  }
}
