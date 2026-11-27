package com.favdevs.pocketnative.hands

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.SystemClock
import android.util.Log
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.Executor

/**
 * The phone's front camera for a phone on a stand facing the operator: CameraX `ImageAnalysis`
 * (about 640×480, RGBA, latest picture only) bound to the Activity's lifecycle, so the camera
 * also stops by itself when the app leaves the front. Pictures are analysed on the hands worker
 * at most every `intervalMs`, only while the models are free, turned upright and never mirrored.
 */
class HandsFrontCamera(
  private val context: Context,
  private val intervalMs: Long,
  private val worker: Executor,
  private val offer: () -> Boolean,
  private val offerDone: () -> Unit,
  private val deliver: (Bitmap) -> Unit,
) {
  companion object {
    private const val TAG = "PocketHandsFront"
  }

  @Volatile private var closed = false
  private var provider: ProcessCameraProvider? = null
  private var analysis: ImageAnalysis? = null
  private var lastMs = 0L

  /** Main thread work, answered on the main thread: null once the camera runs, or why not. */
  fun start(owner: LifecycleOwner, rotation: Int, done: (String?) -> Unit) {
    val main = ContextCompat.getMainExecutor(context)
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      if (closed) {
        done("stopped")
        return@addListener
      }
      try {
        val cameras = future.get()
        if (!cameras.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)) {
          done("this phone has no front camera")
          return@addListener
        }
        val selector = ResolutionSelector.Builder()
          .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
          .setResolutionStrategy(ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
          .build()
        val useCase = ImageAnalysis.Builder()
          .setResolutionSelector(selector)
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
          .setTargetRotation(rotation)
          .build()
        useCase.setAnalyzer(worker) { proxy -> analyse(proxy) }
        cameras.bindToLifecycle(owner, CameraSelector.DEFAULT_FRONT_CAMERA, useCase)
        provider = cameras
        analysis = useCase
        done(null)
      } catch (t: Throwable) {
        Log.w(TAG, "front camera did not start", t)
        done("the front camera is busy")
      }
    }, main)
  }

  /** Stops the camera (unbinds only this reader's use case). */
  fun close() {
    closed = true
    val main = ContextCompat.getMainExecutor(context)
    main.execute {
      val useCase = analysis ?: return@execute
      useCase.clearAnalyzer()
      runCatching { provider?.unbind(useCase) }
      analysis = null
      provider = null
    }
  }

  /** Worker. */
  private fun analyse(proxy: ImageProxy) {
    var handed = false
    var taken = false
    try {
      if (closed) return
      val now = SystemClock.uptimeMillis()
      if (now - lastMs < intervalMs * 9 / 10) return
      if (!offer()) return
      taken = true
      lastMs = now
      val raw = proxy.toBitmap()
      val degrees = proxy.imageInfo.rotationDegrees
      val upright = if (degrees == 0) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
      handed = true
      deliver(upright)
    } catch (t: Throwable) {
      Log.w(TAG, "front picture failed", t)
    } finally {
      proxy.close()
      if (taken && !handed) offerDone()
    }
  }
}
