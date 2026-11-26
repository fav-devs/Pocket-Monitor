package com.favdevs.opcnative.video

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
 * JS module `OpcVideo` (OpcVideoNativeModule) with views `OpcVideoView` and `OpcScopeView`.
 *
 * Classic Module DSL, not the v2 `@ExpoModule` compiler plugin: the v2 Kotlin API has no view
 * support we can see in SDK 58 (expo-haptics, the only v2 module, has none), and this class is
 * listed in expo-module.config.json, which classic autolinking instantiates. VERIFY: a classic
 * module inside a `v2 true` Gradle project builds and registers alongside v2 modules.
 */
class OpcVideoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpcVideo")

    AsyncFunction("loadLut") { id: String, cubeText: String ->
      try {
        OpcVideoLutRegistry.load(id, cubeText)
      } catch (e: OpcVideoLutException) {
        throw CodedException("ERR_OPC_LUT", e.message ?: "LUT load failed", e)
      }
    }

    Function("unloadLut") { id: String ->
      OpcVideoLutRegistry.unload(id)
    }

    AsyncFunction("snapshot") { sessionId: String, withEffects: Boolean, promise: Promise ->
      val session = OpcVideoSessionHub.existing(sessionId)
      if (session == null || session.frameSequence == 0L) {
        promise.reject("ERR_OPC_NO_FRAME", "No decoded frame for session $sessionId.", null)
        return@AsyncFunction
      }
      val fx = if (withEffects) session.lastEffects else OpcPictureEffects()
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
        promise.reject("ERR_OPC_SNAPSHOT", "No cache directory.", null)
        return@AsyncFunction
      }
      OpcVideoGl.post {
        val rgba = OpcVideoRenderer.renderOffscreen(OpcVideoSource.Frame(session), fx, w, h, stretch = false)
        if (rgba == null) {
          promise.reject("ERR_OPC_SNAPSHOT", "Snapshot render failed.", null)
          return@post
        }
        // JPEG encode off the GL thread.
        Thread {
          try {
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(rgba)) // ARGB_8888 memory order is RGBA
            val dir = File(cacheDir, "opc-snapshots").apply { mkdirs() }
            val file = File(dir, "snapshot-${UUID.randomUUID()}.jpg")
            FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.JPEG, 92, it) }
            bitmap.recycle()
            promise.resolve(Uri.fromFile(file).toString())
          } catch (e: Exception) {
            promise.reject("ERR_OPC_SNAPSHOT", e.message ?: "JPEG encode failed", e)
          }
        }.start()
      }
    }

    AsyncFunction("sampleFrame") { sessionId: String, width: Int, height: Int, promise: Promise ->
      val session = OpcVideoSessionHub.existing(sessionId)
      if (session == null || session.frameSequence == 0L) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val w = width.coerceIn(1, 1024)
      val h = height.coerceIn(1, 1024)
      OpcVideoGl.post {
        // The camera signal, unprocessed: meters read codes, not the monitoring look.
        val rgba = OpcVideoRenderer.renderOffscreen(OpcVideoSource.Frame(session), OpcPictureEffects(), w, h, stretch = true)
        // VERIFY: a ByteArray inside a map reaches JS as a Uint8Array (JSTypeConverter ByteArray path).
        promise.resolve(rgba?.let { mapOf("width" to w, "height" to h, "rgba" to it) })
      }
    }

    View(OpcVideoView::class) {
      Name("OpcVideoView")
      Events("onFrameStats")
      Prop("sessionId") { view: OpcVideoView, id: String? -> view.setSessionId(id) }
      Prop("demoScene") { view: OpcVideoView, scene: String? -> view.setDemoScene(scene) }
      Prop("effects") { view: OpcVideoView, effects: Map<String, Any?>? -> view.setEffects(effects) }
      Prop("resizeMode") { view: OpcVideoView, mode: String? -> view.setResizeMode(mode) }
      OnViewDestroys { view: OpcVideoView -> view.destroy() }
    }

    View(OpcScopeView::class) {
      Name("OpcScopeView")
      Prop("sessionId") { view: OpcScopeView, id: String? -> view.setSessionId(id) }
      Prop("demoScene") { view: OpcScopeView, scene: String? -> view.setDemoScene(scene) }
      Prop("kind") { view: OpcScopeView, kind: String? -> view.setKind(kind) }
      Prop("options") { view: OpcScopeView, options: Map<String, Any?>? -> view.setOptions(options) }
      Prop("brightness") { view: OpcScopeView, value: Double? -> view.setBrightness(value) }
      Prop("measureAfterLut") { view: OpcScopeView, value: Boolean? -> view.setMeasureAfterLut(value) }
      Prop("effects") { view: OpcScopeView, effects: Map<String, Any?>? -> view.setEffects(effects) }
      OnViewDestroys { view: OpcScopeView -> view.destroy() }
    }
  }
}
