package com.favdevs.opcnative.headmotion

import io.github.expo.modules.v2.Event
import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.JavaScriptThrowable
import io.github.expo.modules.v2.Module

/**
 * Head tracking is iOS-only (AirPods IMU through `CMHeadphoneMotionManager`). Android has no
 * equivalent headphone IMU API, so this module reports unavailable and never emits.
 */
@ExpoModule("OpcHeadMotion")
class OpcHeadMotionModule : Module() {
  class UnavailableException : JavaScriptThrowable("Head tracking is not available on Android") {
    override val code: String get() = "ERR_HEAD_MOTION_UNAVAILABLE"
  }

  @Event("onSample")
  val onSample: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onConnection")
  val onConnection: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @JS
  fun isAvailable(): Boolean = false

  @JS
  suspend fun start() {
    throw UnavailableException()
  }

  @JS
  fun stop() = Unit
}
