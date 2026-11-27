package com.favdevs.pocketnative.hands

import io.github.expo.modules.v2.Event
import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.JavaScriptThrowable
import io.github.expo.modules.v2.Module
import io.github.expo.modules.v2.react.androidContext
import io.github.expo.modules.v2.react.currentActivity

/**
 * JS module `PocketHands` (`src/types.ts` `PocketHandsNativeModule`): hands and faces read with
 * MediaPipe Tasks (hand landmarker on the GPU delegate, the CPU when the GPU will not load; the
 * short-range face detector on the CPU) from the camera's decoded live picture or the front
 * camera, and the microphone's level blocks for the double clap. Every gesture rule is
 * TypeScript (`src/core/gestures`); this only reads pictures and sound, off the render path, and
 * only while JS has it started (gestures on, the live view in front).
 */
@ExpoModule("PocketHands")
class PocketHandsModule : Module() {
  class HandsException(message: String) : JavaScriptThrowable(message) {
    override val code: String get() = "ERR_POCKET_HANDS"
  }

  @Event("onHands")
  val onHands: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onStatus")
  val onStatus: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onAudio")
  val onAudio: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Volatile private var created: HandsReader? = null
  private val reader: HandsReader
    get() = created ?: synchronized(this) {
      created ?: HandsReader(
        androidContext,
        seen = { onHands.emit(it) },
        status = { state, provider, error -> onStatus.emit(mapOf("state" to state, "provider" to provider, "error" to error)) },
      ).also { created = it }
    }

  private val microphone = HandsMicrophone { rate, peaks, levels ->
    onAudio.emit(mapOf("sampleRate" to rate, "peaks" to peaks, "levels" to levels))
  }

  @JS
  fun isAvailable(): Boolean = true

  @JS
  suspend fun start(options: Map<String, Any?>) {
    val error = reader.start(
      source = if (options["source"] == "frontCamera") HandsReader.Source.FRONT_CAMERA else HandsReader.Source.CAMERA_FEED,
      sessionId = options["sessionId"] as? String,
      rate = (options["rate"] as? Number)?.toDouble() ?: 15.0,
      width = (options["width"] as? Number)?.toInt() ?: 480,
      activity = currentActivity,
    )
    if (error != null) throw HandsException(error)
  }

  @JS
  fun stop() {
    created?.stop()
  }

  @JS
  fun setWantsFaces(on: Boolean) {
    created?.setWantsFaces(on)
  }

  @JS
  suspend fun startMicrophone() {
    val error = microphone.start(androidContext)
    if (error != null) throw HandsException(error)
  }

  @JS
  fun stopMicrophone() {
    microphone.stop()
  }

  override fun onDestroy() {
    created?.close()
    created = null
    microphone.stop()
  }
}
