package com.favdevs.pocketnative.edit

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * MediaPipe Face Landmarker for the editor's face stage (`assets/pocket-hands/face_landmarker.task`,
 * see NOTICE.md there): BlazeFace short range finds faces, the 478-point face mesh reads them, in
 * VIDEO mode (it follows a face between pictures instead of finding it every time), up to three
 * faces, GPU delegate with a CPU fallback like the hand landmarker. Each face is reduced to the
 * FACE_LANDMARK_INDICES points, plus the cheeks' colour (for the tone check and Auto).
 *
 * One instance per face effect program, used only on that program's worker thread.
 */
class PocketFaceLandmarker(private val context: Context) {
  companion object {
    private const val TAG = "PocketFace"
    private const val MODEL = "pocket-hands/face_landmarker.task"

    @Volatile private var modelBytes: ByteBuffer? = null

    private fun model(context: Context): ByteBuffer? {
      modelBytes?.let { return it.duplicate().apply { rewind() } }
      return try {
        val bytes = context.assets.open(MODEL).use { it.readBytes() }
        ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).apply {
          put(bytes)
          rewind()
        }.also { modelBytes = it }.duplicate()
      } catch (t: Throwable) {
        Log.e(TAG, "the face model is missing", t)
        null
      }
    }
  }

  private var landmarker: FaceLandmarker? = null
  private var failed = false
  private var lastTimestampMs = 0L

  private fun create(delegate: Delegate): FaceLandmarker? {
    val buffer = model(context) ?: return null
    return FaceLandmarker.createFromOptions(
      context,
      FaceLandmarker.FaceLandmarkerOptions.builder()
        .setBaseOptions(BaseOptions.builder().setModelAssetBuffer(buffer).setDelegate(delegate).build())
        .setRunningMode(RunningMode.VIDEO)
        .setNumFaces(PocketFaceMath.MAX_FACES)
        .setMinFaceDetectionConfidence(0.5f)
        .setMinFacePresenceConfidence(0.5f)
        .setMinTrackingConfidence(0.5f)
        .setOutputFaceBlendshapes(false)
        .setOutputFacialTransformationMatrixes(false)
        .build(),
    )
  }

  private fun ready(): FaceLandmarker? {
    landmarker?.let { return it }
    if (failed) return null
    landmarker = try {
      create(Delegate.GPU)
    } catch (t: Throwable) {
      Log.w(TAG, "face landmarker: GPU delegate unavailable, using the CPU", t)
      null
    } ?: try {
      create(Delegate.CPU)
    } catch (t: Throwable) {
      Log.e(TAG, "face landmarker failed to load", t)
      null
    }
    if (landmarker == null) failed = true
    return landmarker
  }

  /** Faces in an upright, top-down picture (the frame small, in the stage's working encoding). */
  fun detect(bitmap: Bitmap, timeMs: Long): List<PocketDetectedFace> {
    val model = ready() ?: return emptyList()
    // VIDEO mode wants rising timestamps; a seek back keeps counting up.
    val ts = if (timeMs > lastTimestampMs) timeMs else lastTimestampMs + 1
    lastTimestampMs = ts
    val result = try {
      model.detectForVideo(BitmapImageBuilder(bitmap).build(), ts)
    } catch (t: Throwable) {
      Log.w(TAG, "face landmarks failed", t)
      return emptyList()
    }
    val out = ArrayList<PocketDetectedFace>()
    for (mesh in result.faceLandmarks()) {
      if (mesh.size < 474) continue
      val points = FloatArray(PocketFaceMath.POINTS * 2)
      for ((k, index) in PocketFaceMath.LANDMARK_INDICES.withIndex()) {
        points[k * 2] = mesh[index].x()
        points[k * 2 + 1] = mesh[index].y()
      }
      out += PocketDetectedFace(points, skinColour(bitmap, points))
    }
    return out
  }

  /** The two cheek apples' mean colour (5 × 5 each), 0…1. */
  private fun skinColour(bitmap: Bitmap, points: FloatArray): FloatArray {
    val rgb = FloatArray(3)
    var n = 0
    for (k in intArrayOf(33, 34)) {
      val cx = (points[k * 2] * bitmap.width).roundToInt()
      val cy = (points[k * 2 + 1] * bitmap.height).roundToInt()
      for (dy in -2..2) for (dx in -2..2) {
        val x = cx + dx
        val y = cy + dy
        if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) continue
        val c = bitmap.getPixel(x, y)
        rgb[0] += ((c shr 16) and 0xff) / 255f
        rgb[1] += ((c shr 8) and 0xff) / 255f
        rgb[2] += (c and 0xff) / 255f
        n++
      }
    }
    if (n > 0) for (i in 0 until 3) rgb[i] /= n
    else rgb.fill(0.5f)
    return rgb
  }

  fun close() {
    runCatching { landmarker?.close() }
    landmarker = null
  }
}

/** A picture `maxWidth` across in proportion, even sides (the landmarker's input). */
internal fun pocketFaceReadSize(width: Int, height: Int, maxWidth: Int): Pair<Int, Int> {
  if (width <= 0 || height <= 0) return 2 to 2
  val long = max(width, height)
  val scale = min(1f, maxWidth.toFloat() / long)
  return max(2, (width * scale).roundToInt() and 1.inv()) to max(2, (height * scale).roundToInt() and 1.inv())
}
