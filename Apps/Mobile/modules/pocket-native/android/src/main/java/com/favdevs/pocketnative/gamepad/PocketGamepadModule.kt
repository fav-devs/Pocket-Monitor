package com.favdevs.pocketnative.gamepad

import android.app.Activity
import android.app.Application
import android.content.Context
import android.hardware.input.InputManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Window
import io.github.expo.modules.v2.Event
import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.Module
import io.github.expo.modules.v2.react.androidContext
import io.github.expo.modules.v2.react.currentActivity
import kotlin.math.abs

/**
 * Emits `onGamepad` (`GamepadState`) for the first connected gamepad, without a View.
 *
 * Gamepad input on Android is delivered to the focused window, not to a system-wide listener. While
 * started, this module wraps the resumed Activity's [Window.Callback] (re-wrapping after Activity
 * recreation via [Application.ActivityLifecycleCallbacks]) and reads `dispatchKeyEvent` /
 * `dispatchGenericMotionEvent` from gamepad / joystick sources before forwarding everything else.
 *
 * Limitations (document in operator copy / README):
 * - Gamepad button and stick events are CONSUMED while started (so BUTTON_B is not turned into
 *   Back and D-pad keys do not move RN focus). Non-gamepad input is untouched.
 * - Input only arrives while one of our Activities is focused (no background input).
 * - Another library that also replaces `Window.Callback` must not be stacked after us and then
 *   removed out of order; [stop] only restores the original when ours is still installed.
 * - Java default methods of `Window.Callback` are not forwarded by Kotlin delegation
 *   (e.g. `onPointerCaptureChanged`); RN does not rely on them.
 * Axes are normalized to GameController's convention: stick up and right are positive.
 */
@ExpoModule("PocketGamepad")
class PocketGamepadModule : Module() {
  @Event("onGamepad")
  val onGamepad: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  private val main = Handler(Looper.getMainLooper())
  // ---- main thread ----
  private var running = false
  private var wrapped: Pair<Window, GamepadWindowCallback>? = null
  private var lifecycle: Application.ActivityLifecycleCallbacks? = null
  private var deviceListener: InputManager.InputDeviceListener? = null
  private var state = PadState()
  private var lastSent: Map<String, Any?>? = null
  private var emitScheduled = false

  private data class PadState(
    val connected: Boolean = false,
    val name: String? = null,
    val leftX: Double = 0.0, val leftY: Double = 0.0,
    val rightX: Double = 0.0, val rightY: Double = 0.0,
    val l2: Double = 0.0, val r2: Double = 0.0,
    val a: Boolean = false, val b: Boolean = false, val x: Boolean = false, val y: Boolean = false,
    val l1: Boolean = false, val r1: Boolean = false,
    val keyUp: Boolean = false, val keyDown: Boolean = false, val keyLeft: Boolean = false, val keyRight: Boolean = false,
    val hatX: Double = 0.0, val hatY: Double = 0.0,
    val menu: Boolean = false,
  ) {
    fun toMap(): Map<String, Any?> = mapOf(
      "connected" to connected,
      "name" to name,
      "leftX" to leftX, "leftY" to leftY, "rightX" to rightX, "rightY" to rightY,
      "l2" to l2, "r2" to r2,
      "buttons" to mapOf(
        "a" to a, "b" to b, "x" to x, "y" to y, "l1" to l1, "r1" to r1,
        "up" to (keyUp || hatY < -0.5), "down" to (keyDown || hatY > 0.5),
        "left" to (keyLeft || hatX < -0.5), "right" to (keyRight || hatX > 0.5),
        "menu" to menu,
      ),
    )
  }

  @JS
  fun start() {
    main.post { startOnMain() }
  }

  @JS
  fun stop() {
    main.post { stopOnMain() }
  }

  override fun onDestroy() {
    main.post { stopOnMain() }
  }

  private fun startOnMain() {
    if (running) return
    running = true
    val app = androidContext.applicationContext as Application
    val callbacks = object : Application.ActivityLifecycleCallbacks {
      override fun onActivityResumed(activity: Activity) = attach(activity)
      override fun onActivityPaused(activity: Activity) {
        if (wrapped?.first === activity.window) detach()
      }
      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
      override fun onActivityStarted(activity: Activity) = Unit
      override fun onActivityStopped(activity: Activity) = Unit
      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
      override fun onActivityDestroyed(activity: Activity) = Unit
    }
    app.registerActivityLifecycleCallbacks(callbacks)
    lifecycle = callbacks
    currentActivity?.let(::attach)

    val input = androidContext.getSystemService(Context.INPUT_SERVICE) as InputManager
    val listener = object : InputManager.InputDeviceListener {
      override fun onInputDeviceAdded(deviceId: Int) = refreshDevices()
      override fun onInputDeviceRemoved(deviceId: Int) = refreshDevices()
      override fun onInputDeviceChanged(deviceId: Int) = refreshDevices()
    }
    input.registerInputDeviceListener(listener, main)
    deviceListener = listener
    refreshDevices(force = true)
  }

  private fun stopOnMain() {
    if (!running) return
    running = false
    detach()
    lifecycle?.let { (androidContext.applicationContext as Application).unregisterActivityLifecycleCallbacks(it) }
    lifecycle = null
    deviceListener?.let { (androidContext.getSystemService(Context.INPUT_SERVICE) as InputManager).unregisterInputDeviceListener(it) }
    deviceListener = null
    state = PadState()
    lastSent = null
  }

  private fun attach(activity: Activity) {
    val window = activity.window ?: return
    if (wrapped?.first === window && window.callback === wrapped?.second) return
    detach()
    val original = window.callback ?: return
    val wrapper = GamepadWindowCallback(original, ::onKey, ::onMotion)
    window.callback = wrapper
    wrapped = window to wrapper
  }

  private fun detach() {
    val (window, wrapper) = wrapped ?: return
    wrapped = null
    // Only restore when ours is still the installed callback.
    if (window.callback === wrapper) window.callback = wrapper.original
  }

  private fun gamepadDevice(): InputDevice? =
    InputDevice.getDeviceIds().asSequence().mapNotNull { InputDevice.getDevice(it) }.firstOrNull { d ->
      !d.isVirtual && ((d.sources and InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD ||
        (d.sources and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK)
    }

  private fun refreshDevices(force: Boolean = false) {
    if (!running) return
    val device = gamepadDevice()
    state = if (device == null) PadState() else state.copy(connected = true, name = device.name)
    emit(force)
  }

  private fun isGamepadSource(source: Int): Boolean =
    (source and InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD ||
      (source and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK ||
      (source and InputDevice.SOURCE_DPAD) == InputDevice.SOURCE_DPAD

  /** Returns true when consumed. Main thread. */
  private fun onKey(event: KeyEvent): Boolean {
    if (!running || !isGamepadSource(event.source)) return false
    val down = event.action == KeyEvent.ACTION_DOWN
    if (event.action != KeyEvent.ACTION_DOWN && event.action != KeyEvent.ACTION_UP) return false
    val s = state
    state = when (event.keyCode) {
      KeyEvent.KEYCODE_BUTTON_A -> s.copy(a = down)
      KeyEvent.KEYCODE_BUTTON_B -> s.copy(b = down)
      KeyEvent.KEYCODE_BUTTON_X -> s.copy(x = down)
      KeyEvent.KEYCODE_BUTTON_Y -> s.copy(y = down)
      KeyEvent.KEYCODE_BUTTON_L1 -> s.copy(l1 = down)
      KeyEvent.KEYCODE_BUTTON_R1 -> s.copy(r1 = down)
      KeyEvent.KEYCODE_BUTTON_L2 -> s.copy(l2 = if (down) 1.0 else 0.0)
      KeyEvent.KEYCODE_BUTTON_R2 -> s.copy(r2 = if (down) 1.0 else 0.0)
      KeyEvent.KEYCODE_DPAD_UP -> s.copy(keyUp = down)
      KeyEvent.KEYCODE_DPAD_DOWN -> s.copy(keyDown = down)
      KeyEvent.KEYCODE_DPAD_LEFT -> s.copy(keyLeft = down)
      KeyEvent.KEYCODE_DPAD_RIGHT -> s.copy(keyRight = down)
      KeyEvent.KEYCODE_BUTTON_START, KeyEvent.KEYCODE_MENU -> s.copy(menu = down)
      else -> return false
    }
    if (!state.connected) state = state.copy(connected = true, name = event.device?.name)
    scheduleEmit()
    return true
  }

  /** Returns true when consumed. Main thread. */
  private fun onMotion(event: MotionEvent): Boolean {
    if (!running || event.action != MotionEvent.ACTION_MOVE) return false
    if ((event.source and InputDevice.SOURCE_JOYSTICK) != InputDevice.SOURCE_JOYSTICK &&
      (event.source and InputDevice.SOURCE_GAMEPAD) != InputDevice.SOURCE_GAMEPAD
    ) return false
    val device = event.device
    fun axis(a: Int): Double {
      val v = event.getAxisValue(a).toDouble()
      val flat = device?.getMotionRange(a, event.source)?.flat?.toDouble() ?: 0.0
      return if (abs(v) <= flat) 0.0 else v.coerceIn(-1.0, 1.0)
    }
    val l2 = maxOf(axis(MotionEvent.AXIS_LTRIGGER), axis(MotionEvent.AXIS_BRAKE)).coerceIn(0.0, 1.0)
    val r2 = maxOf(axis(MotionEvent.AXIS_RTRIGGER), axis(MotionEvent.AXIS_GAS)).coerceIn(0.0, 1.0)
    state = state.copy(
      connected = true,
      name = state.name ?: device?.name,
      leftX = axis(MotionEvent.AXIS_X),
      leftY = -axis(MotionEvent.AXIS_Y), // Android: down is positive
      rightX = axis(MotionEvent.AXIS_Z),
      rightY = -axis(MotionEvent.AXIS_RZ),
      l2 = l2,
      r2 = r2,
      hatX = axis(MotionEvent.AXIS_HAT_X),
      hatY = axis(MotionEvent.AXIS_HAT_Y),
    )
    scheduleEmit()
    return true
  }

  /** Coalesce bursts into one emit per ~16 ms; only changes are sent. */
  private fun scheduleEmit() {
    if (emitScheduled) return
    emitScheduled = true
    main.postDelayed({
      emitScheduled = false
      emit(false)
    }, 16)
  }

  private fun emit(force: Boolean) {
    if (!running) return
    val payload = state.toMap()
    if (!force && payload == lastSent) return
    lastSent = payload
    onGamepad.emit(payload)
  }
}

/** Forwards every [Window.Callback] call to [original], peeking at gamepad input first. */
internal class GamepadWindowCallback(
  val original: Window.Callback,
  private val onKey: (KeyEvent) -> Boolean,
  private val onMotion: (MotionEvent) -> Boolean,
) : Window.Callback by original {
  override fun dispatchKeyEvent(event: KeyEvent): Boolean =
    onKey(event) || original.dispatchKeyEvent(event)

  override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean =
    onMotion(event) || original.dispatchGenericMotionEvent(event)
}
