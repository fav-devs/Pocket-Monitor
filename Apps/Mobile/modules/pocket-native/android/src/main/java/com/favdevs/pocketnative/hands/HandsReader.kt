package com.favdevs.pocketnative.hands

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.favdevs.pocketnative.video.PocketVideoSessionHub
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facedetector.FaceDetector
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Reads hands (and faces when asked) with MediaPipe Tasks on one worker thread, `pocket-hands`.
 *
 * - Models: the hand landmarker (`assets/pocket-hands/hand_landmarker.task`, VIDEO mode, two
 *   hands, so it tracks between pictures instead of finding the palms every time) on the GPU
 *   delegate, or the CPU when the GPU delegate will not load; the short-range face detector
 *   (`blaze_face_short_range.tflite`, IMAGE mode, CPU) at most every 0.25 s while faces are wanted.
 *   Loaded on the first start and kept until the module goes; one reader for the app.
 * - `cameraFeed`: [HandsFeedTap] on the decoder's GL thread draws the latest picture small into an
 *   `ImageReader` at the offer rate, only while the models are free (one picture in flight;
 *   others are dropped), and the worker reads it back from the reader's buffer — no `glReadPixels`
 *   on the render thread.
 * - `frontCamera`: [HandsFrontCamera] (CameraX `ImageAnalysis`, about 640×480, latest picture
 *   only) analysed on the same worker, turned upright.
 *
 * Landmarks are MediaPipe's own, in picture fractions; `right` is MediaPipe's handedness label on
 * the unmirrored picture, as the desktop reads it.
 */
class HandsReader(
  private val context: Context,
  private val seen: (Map<String, Any?>) -> Unit,
  private val status: (state: String, provider: String?, error: String?) -> Unit,
) {
  enum class Source(val js: String) { CAMERA_FEED("cameraFeed"), FRONT_CAMERA("frontCamera") }

  companion object {
    private const val TAG = "PocketHands"
    private const val HAND_MODEL = "pocket-hands/hand_landmarker.task"
    private const val FACE_MODEL = "pocket-hands/blaze_face_short_range.tflite"
    private const val FACE_INTERVAL_MS = 250L
    /** A picture handed to the models and never answered frees the reader after this. */
    private const val STUCK_NANOS = 1_000_000_000L
  }

  private val thread = HandlerThread("pocket-hands", Process.THREAD_PRIORITY_DEFAULT).apply { start() }
  private val handler = Handler(thread.looper)
  private val worker = Executor { handler.post(it) }
  /** A picture is with the models. Set by whoever offers one, cleared when it is read. */
  private val busy = AtomicBoolean(false)
  private val busySince = AtomicLong(0)
  @Volatile private var wantsFaces = false
  /** Bumped on every start and stop; a picture from an earlier start is not read. */
  @Volatile private var generation = 0

  // ---- worker-confined ----
  private var hands: HandLandmarker? = null
  private var faces: FaceDetector? = null
  private var provider = "CPU"
  private var source = Source.CAMERA_FEED
  private var lastFaceAskMs = 0L
  private var lastTimestampMs = 0L
  private var feed: HandsFeedTap? = null
  private var feedSpec: FeedSpec? = null
  private var front: HandsFrontCamera? = null

  private val follow = Runnable { followFeed() }

  private class FeedSpec(val sessionId: String, val width: Int, val intervalNanos: Long, val generation: Int)

  /** Starts (or switches) the source. Returns why not, or null once it runs. */
  suspend fun start(source: Source, sessionId: String?, rate: Double, width: Int, activity: Activity?): String? {
    val intervalMs = (1000.0 / rate.coerceIn(1.0, 20.0)).toLong()
    val error = onWorker { prepare(source, sessionId, intervalMs, width.coerceIn(160, 960)) }
    if (error != null) return fail(error)
    if (source != Source.FRONT_CAMERA) return ready()
    val owner = activity as? LifecycleOwner ?: return fail("the app is not in front")
    @Suppress("DEPRECATION")
    val rotation = activity.windowManager.defaultDisplay.rotation
    val camera = onWorker { front } ?: return fail("stopped")
    val started = suspendCancellableCoroutine { cont -> camera.start(owner, rotation) { cont.resume(it) } }
    return if (started != null) fail(started) else ready()
  }

  fun stop() {
    handler.post {
      val was = feed != null || front != null
      generation += 1
      teardownSources()
      if (was) status("stopped", null, null)
    }
  }

  fun setWantsFaces(on: Boolean) {
    wantsFaces = on
  }

  /** Stops and frees the models and the worker (the module going). */
  fun close() {
    handler.post {
      generation += 1
      teardownSources()
      runCatching { hands?.close() }
      runCatching { faces?.close() }
      hands = null
      faces = null
      thread.quitSafely()
    }
  }

  // ---- worker ----

  private suspend fun <T> onWorker(block: () -> T): T = suspendCancellableCoroutine { cont -> handler.post { cont.resume(block()) } }

  private suspend fun fail(error: String): String {
    onWorker { teardownSources() }
    status("failed", null, error)
    return error
  }

  private fun ready(): String? {
    status("ready", provider, null)
    return null
  }

  private fun prepare(source: Source, sessionId: String?, intervalMs: Long, width: Int): String? {
    generation += 1
    teardownSources()
    this.source = source
    busy.set(false)
    status("starting", null, null)
    loadModels()?.let { return it }
    val generationNow = generation
    return when (source) {
      Source.CAMERA_FEED -> {
        val id = sessionId ?: return "no picture to read"
        if (PocketVideoSessionHub.existing(id) == null) return "no picture to read"
        feedSpec = FeedSpec(id, width, intervalMs * 1_000_000L, generationNow)
        followFeed()
        null
      }
      Source.FRONT_CAMERA -> {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
          return "camera access is off"
        }
        front = HandsFrontCamera(context, intervalMs, worker, ::offer, { busy.set(false) }) { bitmap -> read(bitmap, generationNow) }
        null
      }
    }
  }

  /**
   * Keeps the tap on the decoder the live view is showing: a view remounted with the same session
   * id gets a new decoder session, so the tap is moved over (checked once a second).
   */
  private fun followFeed() {
    val spec = feedSpec ?: return
    if (spec.generation != generation) return
    val session = PocketVideoSessionHub.existing(spec.sessionId)
    if (session != null && feed?.session !== session) {
      feed?.close()
      feed = HandsFeedTap(session, spec.width, spec.intervalNanos, handler, ::offer, { busy.set(false) }) { bitmap -> read(bitmap, spec.generation) }.also {
        session.addFrameTap(it)
      }
    }
    handler.removeCallbacks(follow)
    handler.postDelayed(follow, 1000)
  }

  /** Takes the models for one picture; false while they are busy (the picture is dropped). */
  private fun offer(): Boolean {
    val now = System.nanoTime()
    if (busy.compareAndSet(false, true)) {
      busySince.set(now)
      return true
    }
    if (now - busySince.get() > STUCK_NANOS) {
      // A picture that never arrived: free the reader rather than stall it for good.
      busySince.set(now)
      return true
    }
    return false
  }

  private fun teardownSources() {
    handler.removeCallbacks(follow)
    feedSpec = null
    feed?.close()
    feed = null
    front?.close()
    front = null
    busy.set(false)
  }

  private fun loadModels(): String? {
    if (hands != null) return null
    val handBytes = try {
      context.assets.open(HAND_MODEL).use { it.readBytes() }
    } catch (t: Throwable) {
      return "the hand model is missing"
    }
    hands = try {
      createHands(handBytes, Delegate.GPU).also { provider = "GPU" }
    } catch (t: Throwable) {
      Log.w(TAG, "hand landmarker: GPU delegate unavailable, using the CPU", t)
      null
    } ?: try {
      createHands(handBytes, Delegate.CPU).also { provider = "CPU" }
    } catch (t: Throwable) {
      Log.e(TAG, "hand landmarker failed to load", t)
      return "the hand model did not load"
    }
    faces = try {
      val faceBytes = context.assets.open(FACE_MODEL).use { it.readBytes() }
      FaceDetector.createFromOptions(
        context,
        FaceDetector.FaceDetectorOptions.builder()
          .setBaseOptions(BaseOptions.builder().setModelAssetBuffer(direct(faceBytes)).setDelegate(Delegate.CPU).build())
          .setRunningMode(RunningMode.IMAGE)
          .setMinDetectionConfidence(0.5f)
          .build(),
      )
    } catch (t: Throwable) {
      Log.w(TAG, "face detector failed to load; face tracking by gesture will find no face", t)
      null
    }
    return null
  }

  private fun createHands(model: ByteArray, delegate: Delegate): HandLandmarker =
    HandLandmarker.createFromOptions(
      context,
      HandLandmarker.HandLandmarkerOptions.builder()
        .setBaseOptions(BaseOptions.builder().setModelAssetBuffer(direct(model)).setDelegate(delegate).build())
        .setRunningMode(RunningMode.VIDEO)
        .setNumHands(2)
        .setMinHandDetectionConfidence(0.5f)
        .setMinHandPresenceConfidence(0.5f)
        .setMinTrackingConfidence(0.5f)
        .build(),
    )

  private fun direct(bytes: ByteArray): ByteBuffer =
    ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).apply {
      put(bytes)
      rewind()
    }

  /** The worker: one upright picture through the models. The bitmap is reused by its source. */
  private fun read(bitmap: Bitmap, generationAt: Int) {
    try {
      if (generationAt != generation) return
      val landmarker = hands ?: return
      // The MPImage only wraps the bitmap; it is not closed, which would recycle the bitmap its
      // source reuses for the next picture.
      val image = BitmapImageBuilder(bitmap).build()
      val started = SystemClock.elapsedRealtimeNanos()
      var timestamp = SystemClock.uptimeMillis()
      if (timestamp <= lastTimestampMs) timestamp = lastTimestampMs + 1
      lastTimestampMs = timestamp
      val result = landmarker.detectForVideo(image, timestamp)
      val handedness = result.handedness()
      val found = result.landmarks().mapIndexedNotNull { i, landmarks ->
        if (landmarks.size < 21) return@mapIndexedNotNull null
        val points = ArrayList<Double>(42)
        for (j in 0 until 21) {
          points.add(landmarks[j].x().toDouble())
          points.add(landmarks[j].y().toDouble())
        }
        val category = handedness.getOrNull(i)?.firstOrNull()
        mapOf("points" to points, "score" to (category?.score()?.toDouble() ?: 0.0), "right" to (category?.categoryName() == "Right"))
      }
      var faceList: List<Map<String, Any?>>? = null
      val detector = faces
      if (wantsFaces && detector != null && timestamp - lastFaceAskMs >= FACE_INTERVAL_MS) {
        lastFaceAskMs = timestamp
        val w = bitmap.width.toDouble()
        val h = bitmap.height.toDouble()
        faceList = detector.detect(image).detections()
          .sortedByDescending { it.boundingBox().width() * it.boundingBox().height() }
          .map { detection ->
            val box = detection.boundingBox()
            mapOf(
              "x" to (box.left / w).coerceIn(0.0, 1.0),
              "y" to (box.top / h).coerceIn(0.0, 1.0),
              "width" to (box.width() / w).coerceIn(0.0, 1.0),
              "height" to (box.height() / h).coerceIn(0.0, 1.0),
              "score" to (detection.categories().firstOrNull()?.score()?.toDouble() ?: 0.0),
            )
          }
      }
      val ms = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0
      if (generationAt != generation) return
      seen(
        mapOf(
          "source" to source.js,
          "hands" to found,
          "faces" to faceList,
          "aspect" to bitmap.width.toDouble() / bitmap.height.coerceAtLeast(1),
          "ms" to ms,
        ),
      )
    } catch (t: Throwable) {
      Log.w(TAG, "hand reading failed", t)
    } finally {
      busy.set(false)
    }
  }
}
