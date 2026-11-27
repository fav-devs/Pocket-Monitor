package com.favdevs.pocketnative.hands

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Process
import android.util.Log
import androidx.core.content.ContextCompat
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * The microphone for the double clap: 16 kHz mono 16-bit `AudioRecord` (the voice-recognition
 * source, which skips automatic gain where the phone allows, so a clap keeps its edge) read on
 * its own thread in 10 ms blocks, each reduced to its peak and RMS level; ten blocks go to JS per
 * call (about ten a second), where `ClapDetector` (`src/core/gestures/clap.ts`) listens. Raw audio
 * never leaves this class and nothing is recorded. Open only while gestures run on the live view.
 */
class HandsMicrophone(private val blocks: (sampleRate: Double, peaks: List<Double>, levels: List<Double>) -> Unit) {
  companion object {
    private const val TAG = "PocketHandsMic"
    private const val RATE = 16_000
    private const val BLOCK = RATE / 100
    private const val BLOCKS_PER_CALL = 10
  }

  @Volatile private var running = false
  private var thread: Thread? = null
  private var record: AudioRecord? = null

  /** Opens it. Returns why not, or null once it listens. */
  @SuppressLint("MissingPermission")
  @Synchronized
  fun start(context: Context): String? {
    if (running) return null
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      return "microphone access is off"
    }
    val minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minimum <= 0) return "this phone has no microphone"
    val created = try {
      AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minimum, RATE / 5 * 2))
    } catch (t: Throwable) {
      return "the microphone could not open"
    }
    if (created.state != AudioRecord.STATE_INITIALIZED) {
      created.release()
      return "the microphone could not open"
    }
    try {
      created.startRecording()
    } catch (t: Throwable) {
      created.release()
      return "the microphone is busy"
    }
    record = created
    running = true
    thread = Thread({ listen(created) }, "pocket-hands-mic").apply { start() }
    return null
  }

  @Synchronized
  fun stop() {
    if (!running) return
    running = false
    thread?.join(300)
    thread = null
    record?.let {
      runCatching { it.stop() }
      it.release()
    }
    record = null
  }

  private fun listen(record: AudioRecord) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    val block = ShortArray(BLOCK)
    val peaks = ArrayList<Double>(BLOCKS_PER_CALL)
    val levels = ArrayList<Double>(BLOCKS_PER_CALL)
    while (running) {
      var filled = 0
      while (filled < BLOCK && running) {
        val n = record.read(block, filled, BLOCK - filled)
        if (n < 0) {
          Log.w(TAG, "microphone read failed: $n")
          return
        }
        filled += n
      }
      if (filled < BLOCK) return
      var peak = 0.0
      var sum = 0.0
      for (s in block) {
        val v = s / 32768.0
        peak = max(peak, abs(v))
        sum += v * v
      }
      peaks.add(peak)
      levels.add(sqrt(sum / BLOCK))
      if (peaks.size >= BLOCKS_PER_CALL) {
        blocks(RATE.toDouble(), ArrayList(peaks), ArrayList(levels))
        peaks.clear()
        levels.clear()
      }
    }
  }
}
