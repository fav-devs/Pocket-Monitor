package com.favdevs.pocketnative.edit

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.sharedobjects.SharedObject
import expo.modules.kotlin.typedarray.Float32Array
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * JS module `PocketEdit` (PocketEditNativeModule in src/edit.ts): the playback editor's colour
 * stage on expo-video's ExoPlayer, the Media3 Transformer exporter and a frame grabber.
 *
 * Classic Module DSL (listed in expo-module.config.json, like PocketVideoModule): it takes
 * expo-video's `VideoPlayer` as a `SharedObject` argument, which the v2 Kotlin API does not cover.
 */
@OptIn(UnstableApi::class)
class PocketEditModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_POCKET_EDIT", "No Android context.", null)

  override fun definition() = ModuleDefinition {
    Name("PocketEdit")

    Events("onExportProgress")

    Function("setLut") { key: String, size: Int, rgb: Float32Array ->
      if (size < 2 || size > 65) throw CodedException("ERR_POCKET_EDIT_LUT", "Unsupported cube size $size.", null)
      val count = size * size * size * 3
      if (rgb.length < count) throw CodedException("ERR_POCKET_EDIT_LUT", "The cube has ${rgb.length} values, expected $count.", null)
      // Copied now, on the JS thread, while the typed array is alive.
      val floats = FloatArray(count)
      rgb.toDirectBuffer().order(ByteOrder.nativeOrder()).asFloatBuffer().get(floats, 0, count)
      PocketEditLuts.set(key, size, floats)
    }

    Function("dropLut") { key: String ->
      PocketEditLuts.drop(key)
    }

    Function("attachPreview") { player: SharedObject, plan: Map<String, Any?> ->
      val exo = exoPlayerOf(player) ?: throw CodedException("ERR_POCKET_EDIT_PLAYER", "Not an expo-video player.", null)
      val state = PocketEditColorEffect.State(plan["lutKey"] as? String, splitOf(plan["split"] as? Map<*, *>))
      val face = PocketFaceParams.from(plan["face"] as? Map<*, *>)
      main.post { PocketEditPreview.attach(exo, state, face) }
    }

    Function("detachPreview") { player: SharedObject ->
      val exo = exoPlayerOf(player) ?: return@Function
      main.post { PocketEditPreview.detach(exo) }
    }

    AsyncFunction("grabFrame") { uri: String, seconds: Double, maxWidth: Int ->
      grabFrame(uri, seconds, maxWidth)
    }

    AsyncFunction("startExport") { jobId: String, plan: Map<String, Any?>, promise: Promise ->
      val ctx = context
      main.post {
        PocketEditExporter.start(ctx, jobId, plan, onProgress = { f ->
          sendEvent("onExportProgress", mapOf("jobId" to jobId, "fraction" to f))
        }, promise = promise)
      }
    }

    Function("cancelExport") { jobId: String ->
      main.post { PocketEditExporter.cancel(jobId) }
    }
  }

  /** expo-video's VideoPlayer keeps its ExoPlayer in `player` (Kotlin property → `getPlayer()`). */
  private fun exoPlayerOf(obj: SharedObject): ExoPlayer? =
    try {
      obj.javaClass.getMethod("getPlayer").invoke(obj) as? ExoPlayer
    } catch (_: Exception) {
      null
    }

  private fun splitOf(map: Map<*, *>?): PocketEditSplit? {
    val axis = map?.get("axis") as? String ?: return null
    val at = (map["at"] as? Number)?.toFloat() ?: return null
    return PocketEditSplit(axis == "x", at, (map["originalLow"] as? Boolean) ?: true)
  }

  private fun grabFrame(uri: String, seconds: Double, maxWidth: Int): Map<String, Any?>? {
    val r = MediaMetadataRetriever()
    try {
      when {
        uri.startsWith("http://") || uri.startsWith("https://") -> r.setDataSource(uri, HashMap())
        uri.startsWith("/") -> r.setDataSource(uri)
        else -> r.setDataSource(context, Uri.parse(uri))
      }
      val frame = r.getFrameAtTime((seconds * 1_000_000).toLong().coerceAtLeast(0), MediaMetadataRetriever.OPTION_CLOSEST_SYNC) ?: return null
      val edge = maxWidth.coerceIn(16, 512)
      val scale = edge.toFloat() / max(frame.width, frame.height)
      val w = max(1, (frame.width * scale).roundToInt())
      val h = max(1, (frame.height * scale).roundToInt())
      val small = Bitmap.createScaledBitmap(frame, w, h, true).copy(Bitmap.Config.ARGB_8888, false)
      if (small !== frame) frame.recycle()
      val buf = ByteBuffer.allocate(w * h * 4)
      small.copyPixelsToBuffer(buf) // ARGB_8888 memory order is RGBA
      small.recycle()
      return mapOf("width" to w, "height" to h, "rgba" to buf.array())
    } catch (_: Exception) {
      return null
    } finally {
      try {
        r.release()
      } catch (_: Exception) {
      }
    }
  }
}

/**
 * The colour and face stages on expo-video's ExoPlayer (`setVideoEffects`), installed once per
 * player; later plans only change the effect's state, which the GL thread reads every frame.
 * Main looper only (expo-video builds its ExoPlayer on it).
 */
@OptIn(UnstableApi::class)
object PocketEditPreview {
  private class Attachment(val color: PocketEditColorEffect, var face: PocketFaceParams)

  private val attachments = WeakHashMap<ExoPlayer, Attachment>()

  fun attach(player: ExoPlayer, state: PocketEditColorEffect.State, face: PocketFaceParams) {
    var att = attachments[player]
    val faceChanged = att != null && att.face != face
    if (att == null) {
      att = Attachment(PocketEditColorEffect(), face)
      att.color.state = state
      attachments[player] = att
      install(player, att)
    } else {
      att.face = face
      att.color.state = state
      if (faceChanged) player.setVideoEffects(effects(att))
    }
    // Paused: show the change on the current frame.
    if (!player.isPlaying && player.playbackState == Player.STATE_READY) player.seekTo(player.currentPosition)
  }

  fun detach(player: ExoPlayer) {
    if (attachments.remove(player) != null) player.setVideoEffects(emptyList())
  }

  private fun effects(att: Attachment): List<Effect> = listOfNotNull(att.color, PocketFaceRetouch.effect(att.face))

  private fun install(player: ExoPlayer, att: Attachment) {
    val prepared = player.playbackState != Player.STATE_IDLE
    player.setVideoEffects(effects(att))
    if (prepared) {
      // VERIFY: the effects pipeline is built when the renderer is (re)configured; re-prepare in
      // place so a player that was already playing picks it up.
      val position = player.currentPosition
      val playWhenReady = player.playWhenReady
      player.stop()
      player.prepare()
      player.seekTo(position)
      player.playWhenReady = playWhenReady
    }
  }
}

/** Media3 Transformer export: colour → face → geometry, audio gain / mute, trim, HDR mode. */
@OptIn(UnstableApi::class)
object PocketEditExporter {
  private val jobs = ConcurrentHashMap<String, Transformer>()
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  private val main = Handler(Looper.getMainLooper())

  fun cancel(jobId: String) {
    cancelled.add(jobId)
    jobs.remove(jobId)?.cancel()
  }

  fun start(context: Context, jobId: String, plan: Map<String, Any?>, onProgress: (Double) -> Unit, promise: Promise) {
    try {
      val source = plan["sourceUri"] as? String ?: throw IllegalArgumentException("The export has no source file.")
      fun num(k: String, f: Double = 0.0) = (plan[k] as? Number)?.toDouble() ?: f
      val lutKey = plan["lutKey"] as? String
      val face = PocketFaceParams.from(plan["face"] as? Map<*, *>)
      val rotation = ((num("rotation").toInt() % 360) + 360) % 360
      val c = plan["crop"] as? Map<*, *>
      fun cn(k: String, f: Float) = (c?.get(k) as? Number)?.toFloat() ?: f
      val crop = floatArrayOf(cn("x", 0f), cn("y", 0f), cn("w", 1f), cn("h", 1f))
      val width = max(2, num("width", 1920.0).toInt())
      val height = max(2, num("height", 1080.0).toInt())
      val volume = num("volume", 1.0).toFloat()
      val keepHdr = plan["keepHdr"] as? Boolean ?: false
      val geometryIdentity = plan["geometryIdentity"] as? Boolean ?: false
      val trim = plan["trim"] as? Map<*, *>

      val video = mutableListOf<Effect>()
      if (lutKey != null && PocketEditLuts.get(lutKey) != null) {
        video += PocketEditColorEffect().apply { state = PocketEditColorEffect.State(lutKey, null) }
      }
      PocketFaceRetouch.effect(face)?.let { video += it }
      val colour = video.isNotEmpty()
      if (!geometryIdentity) {
        video += PocketEditPipeline.geometry(rotation, crop, plan["flipH"] as? Boolean ?: false, plan["flipV"] as? Boolean ?: false, width, height)
      }
      val audio = mutableListOf<AudioProcessor>()
      if (volume > 0.001f && kotlin.math.abs(volume - 1f) > 0.001f) {
        audio += ChannelMixingAudioProcessor().apply {
          for (ch in 1..2) putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(ch, ch).scaleBy(volume))
        }
      }

      val item = MediaItem.Builder().setUri(Uri.parse(source)).apply {
        val s = (trim?.get("start") as? Number)?.toDouble()
        val e = (trim?.get("end") as? Number)?.toDouble()
        if (s != null && e != null && e > s) {
          setClippingConfiguration(
            MediaItem.ClippingConfiguration.Builder()
              .setStartPositionMs((s * 1000).toLong())
              .setEndPositionMs((e * 1000).toLong())
              .build(),
          )
        }
      }.build()
      val edited = EditedMediaItem.Builder(item)
        .setEffects(Effects(audio, video))
        .setRemoveAudio(volume <= 0.001f)
        .build()
      // The colour shader works on SDR code values: an HDR clip with a look is tone-mapped.
      val hdrMode = if (keepHdr && !colour) Composition.HDR_MODE_KEEP_HDR else Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL
      // The item-based builder infers the track types from the item (a clip without audio works);
      // its replacement needs them up front.
      @Suppress("DEPRECATION")
      val sequence = EditedMediaItemSequence.Builder(edited).build()
      val composition = Composition.Builder(sequence).setHdrMode(hdrMode).build()

      val dir = File(context.cacheDir, "pocket-edits").apply { mkdirs() }
      val out = File(dir, (plan["outputName"] as? String) ?: "edit.mp4")
      if (out.exists()) out.delete()
      val holder = ProgressHolder()
      lateinit var poll: Runnable
      val transformer = Transformer.Builder(context)
        .setVideoMimeType(MimeTypes.VIDEO_H265)
        .addListener(object : Transformer.Listener {
          override fun onCompleted(composition: Composition, exportResult: ExportResult) {
            main.removeCallbacks(poll)
            jobs.remove(jobId)
            onProgress(1.0)
            promise.resolve(Uri.fromFile(out).toString())
          }

          override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
            main.removeCallbacks(poll)
            jobs.remove(jobId)
            out.delete()
            if (cancelled.remove(jobId)) promise.reject("ERR_POCKET_EDIT_EXPORT", "Export cancelled", null)
            else promise.reject("ERR_POCKET_EDIT_EXPORT", exportException.message ?: "Export failed", exportException)
          }
        })
        .build()
      jobs[jobId] = transformer
      poll = Runnable {
        val t = jobs[jobId] ?: return@Runnable
        if (t.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) onProgress(holder.progress / 100.0)
        main.postDelayed(poll, 200)
      }
      if (cancelled.remove(jobId)) {
        jobs.remove(jobId)
        promise.reject("ERR_POCKET_EDIT_EXPORT", "Export cancelled", null)
        return
      }
      transformer.start(composition, out.absolutePath)
      main.postDelayed(poll, 200)
    } catch (e: Exception) {
      jobs.remove(jobId)
      promise.reject("ERR_POCKET_EDIT_EXPORT", e.message ?: "Export failed", e)
    }
  }
}

