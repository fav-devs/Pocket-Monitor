package com.favdevs.pocketnative.video

import android.graphics.Bitmap
import android.net.Uri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.util.UUID
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * JS module `PocketVideo` (PocketVideoNativeModule) with views `PocketVideoView` and `PocketScopeView`.
 *
 * Classic Module DSL, not the v2 `@ExpoModule` compiler plugin: the v2 Kotlin API has no view
 * support we can see in SDK 58 (expo-haptics, the only v2 module, has none), and this class is
 * listed in expo-module.config.json, which classic autolinking instantiates. VERIFY: a classic
 * module inside a `v2 true` Gradle project builds and registers alongside v2 modules.
 */
class PocketVideoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PocketVideo")

    AsyncFunction("loadLut") { id: String, cubeText: String ->
      try {
        PocketVideoLutRegistry.load(id, cubeText)
      } catch (e: PocketVideoLutException) {
        throw CodedException("ERR_POCKET_LUT", e.message ?: "LUT load failed", e)
      }
    }

    Function("unloadLut") { id: String ->
      PocketVideoLutRegistry.unload(id)
    }

    AsyncFunction("snapshot") { sessionId: String, withEffects: Boolean, promise: Promise ->
      val session = PocketVideoSessionHub.existing(sessionId)
      if (session == null || session.frameSequence == 0L) {
        promise.reject("ERR_POCKET_NO_FRAME", "No decoded frame for session $sessionId.", null)
        return@AsyncFunction
      }
      val fx = if (withEffects) session.lastEffects else PocketPictureEffects()
      var w = max(session.width, 1)
      var h = max(session.height, 1)
      if (withEffects && kotlin.math.abs(fx.desqueeze - 1f) > 0.001f) {
        if (fx.desqueezeVertical) h = (h * fx.desqueeze).roundToInt() else w = (w * fx.desqueeze).roundToInt()
      }
      val scale = min(1.0, 4096.0 / max(w, h))
      w = max(1, (w * scale).toInt())
      h = max(1, (h * scale).toInt())
      val cacheDir = appContext.reactContext?.cacheDir
      if (cacheDir == null) {
        promise.reject("ERR_POCKET_SNAPSHOT", "No cache directory.", null)
        return@AsyncFunction
      }
      PocketVideoGl.post {
        val rgba = PocketVideoRenderer.renderOffscreen(PocketVideoSource.Frame(session), fx, w, h, stretch = false)
        if (rgba == null) {
          promise.reject("ERR_POCKET_SNAPSHOT", "Snapshot render failed.", null)
          return@post
        }
        // JPEG encode off the GL thread.
        Thread {
          try {
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(rgba)) // ARGB_8888 memory order is RGBA
            val dir = File(cacheDir, "pocket-snapshots").apply { mkdirs() }
            val file = File(dir, "snapshot-${UUID.randomUUID()}.jpg")
            FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.JPEG, 92, it) }
            bitmap.recycle()
            promise.resolve(Uri.fromFile(file).toString())
          } catch (e: Exception) {
            promise.reject("ERR_POCKET_SNAPSHOT", e.message ?: "JPEG encode failed", e)
          }
        }.start()
      }
    }

    AsyncFunction("sampleFrame") { sessionId: String, width: Int, height: Int, promise: Promise ->
      val session = PocketVideoSessionHub.existing(sessionId)
      if (session == null || session.frameSequence == 0L) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val w = width.coerceIn(1, 1024)
      val h = height.coerceIn(1, 1024)
      PocketVideoGl.post {
        // The camera signal, unprocessed: meters read codes, not the monitoring look.
        val rgba = PocketVideoRenderer.renderOffscreen(PocketVideoSource.Frame(session), PocketPictureEffects(), w, h, stretch = true)
        // VERIFY: a ByteArray inside a map reaches JS as a Uint8Array (JSTypeConverter ByteArray path).
        promise.resolve(rgba?.let { mapOf("width" to w, "height" to h, "rgba" to it) })
      }
    }

    View(PocketVideoView::class) {
      Name("PocketVideoView")
      Events("onFrameStats")
      Prop("sessionId") { view: PocketVideoView, id: String? -> view.setSessionId(id) }
      Prop("demoScene") { view: PocketVideoView, scene: String? -> view.setDemoScene(scene) }
      Prop("effects") { view: PocketVideoView, effects: Map<String, Any?>? -> view.setEffects(effects) }
      Prop("resizeMode") { view: PocketVideoView, mode: String? -> view.setResizeMode(mode) }
      OnViewDestroys { view: PocketVideoView -> view.destroy() }
    }

    View(PocketScopeView::class) {
      Name("PocketScopeView")
      Prop("sessionId") { view: PocketScopeView, id: String? -> view.setSessionId(id) }
      Prop("demoScene") { view: PocketScopeView, scene: String? -> view.setDemoScene(scene) }
      Prop("kind") { view: PocketScopeView, kind: String? -> view.setKind(kind) }
      Prop("options") { view: PocketScopeView, options: Map<String, Any?>? -> view.setOptions(options) }
      Prop("brightness") { view: PocketScopeView, value: Double? -> view.setBrightness(value) }
      Prop("measureAfterLut") { view: PocketScopeView, value: Boolean? -> view.setMeasureAfterLut(value) }
      Prop("effects") { view: PocketScopeView, effects: Map<String, Any?>? -> view.setEffects(effects) }
      OnViewDestroys { view: PocketScopeView -> view.destroy() }
    }
  }
}
