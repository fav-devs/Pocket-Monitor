package com.favdevs.pocketnative.video

import android.content.Context
import android.graphics.SurfaceTexture
import android.opengl.EGLSurface
import android.opengl.GLES30
import android.view.TextureView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Base for the picture and scope views: a TextureView whose surface the GL thread renders into,
 * a session reference and the vsync hook.
 */
abstract class PocketVideoSurfaceView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), TextureView.SurfaceTextureListener, PocketGlTarget {

  protected val textureView = TextureView(context)
  protected val density: Double = context.resources.displayMetrics.density.toDouble()

  // GL thread.
  protected var eglSurface: EGLSurface? = null
  protected var surfaceWidth = 0
  protected var surfaceHeight = 0
  protected val renderer = PocketVideoRenderer()

  /** Set from the main thread, read on the GL thread. */
  @Volatile protected var session: PocketVideoSession? = null
  @Volatile protected var dirty = true
  private var sessionId: String? = null
  private var destroyed = false

  init {
    textureView.surfaceTextureListener = this
    addView(textureView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    // React Native owns layout; size the TextureView to our frame ourselves.
    val w = r - l
    val h = b - t
    textureView.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    textureView.layout(0, 0, w, h)
  }

  fun setSessionId(id: String?) {
    if (id == sessionId || destroyed) return
    session?.let { PocketVideoSessionHub.release(it) }
    sessionId = id
    session = id?.let { PocketVideoSessionHub.acquire(it) }
    onSessionChanged()
    dirty = true
  }

  protected open fun onSessionChanged() {}

  /** OnViewDestroys. */
  fun destroy() {
    if (destroyed) return
    destroyed = true
    PocketVideoGl.unregister(this)
    session?.let { PocketVideoSessionHub.release(it) }
    session = null
    PocketVideoGl.post { renderer.release() }
  }

  // ─── TextureView.SurfaceTextureListener (main thread) ─────────────────────────────

  override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
    PocketVideoGl.post {
      eglSurface = PocketVideoGl.createWindowSurface(st)
      surfaceWidth = width
      surfaceHeight = height
      dirty = true
    }
    PocketVideoGl.register(this)
  }

  override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {
    PocketVideoGl.post {
      surfaceWidth = width
      surfaceHeight = height
      dirty = true
    }
  }

  override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
    PocketVideoGl.unregister(this)
    // The EGL surface must be gone before TextureView releases the SurfaceTexture.
    PocketVideoGl.sync(500) {
      eglSurface?.let { PocketVideoGl.destroySurface(it) }
      eglSurface = null
    }
    return true
  }

  override fun onSurfaceTextureUpdated(st: SurfaceTexture) = Unit

  /** GL thread: make our window surface current; false when there is nothing to draw into. */
  protected fun beginWindow(): Boolean {
    val surface = eglSurface ?: return false
    if (surfaceWidth <= 0 || surfaceHeight <= 0) return false
    return PocketVideoGl.makeCurrent(surface)
  }

  protected fun endWindow() {
    eglSurface?.let { PocketVideoGl.swap(it) }
  }

  protected fun clearWindow(r: Float, g: Float, b: Float, a: Float) {
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
    GLES30.glViewport(0, 0, surfaceWidth, surfaceHeight)
    GLES30.glClearColor(r, g, b, a)
    GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
  }
}

/**
 * `PocketVideoView` (VideoViewProps). Present policy: at each vsync draw only when the session
 * latched a newer frame than the one shown (latest wins; skipped frames count as dropped) or
 * props changed; demo scenes animate at 30 Hz.
 */
class PocketVideoView(context: Context, appContext: AppContext) : PocketVideoSurfaceView(context, appContext) {
  private val onFrameStats by EventDispatcher<Map<String, Any>>()

  @Volatile private var demoScene: Int? = null
  @Volatile private var effects = PocketPictureEffects()
  @Volatile private var fill = false

  // GL thread.
  private var lastSequence = 0L
  private var lastDemoNanos = 0L
  private var demoEpochNanos = System.nanoTime()
  private var lastWidth = 0
  private var lastHeight = 0
  private var windowStartNanos = System.nanoTime()
  private var presentedInWindow = 0
  private var decodedAtWindowStart = 0L
  private var superseded = 0L

  init {
    textureView.isOpaque = true
  }

  fun setDemoScene(scene: String?) {
    demoScene = PocketVideoSource.demoScene(scene)
    demoEpochNanos = System.nanoTime()
    dirty = true
  }

  fun setEffects(map: Map<String, Any?>?) {
    val parsed = PocketPictureEffects.parse(map)
    if (parsed != effects) {
      effects = parsed
      dirty = true
    }
  }

  fun setResizeMode(mode: String?) {
    val next = mode == "fill"
    if (next != fill) {
      fill = next
      dirty = true
    }
  }

  override fun onSessionChanged() {
    PocketVideoGl.post {
      lastSequence = 0
      superseded = 0
      decodedAtWindowStart = session?.decodedTotal ?: 0
    }
  }

  override fun onGlFrame(frameTimeNanos: Long) {
    val now = System.nanoTime()
    emitStatsIfDue(now)
    val s = session
    val fx = effects
    val demo = demoScene
    val source: PocketVideoSource? = when {
      s != null -> {
        val seq = s.frameSequence
        if (seq == 0L) null else {
          if (seq == lastSequence && !dirty) return
          if (lastSequence > 0 && seq > lastSequence + 1) superseded += seq - lastSequence - 1
          lastSequence = seq
          PocketVideoSource.Frame(s)
        }
      }
      demo != null -> {
        if (!dirty && now - lastDemoNanos < 33_000_000L) return
        lastDemoNanos = now
        PocketVideoSource.Demo(demo, (now - demoEpochNanos) / 1e9f, fx.sourceColor)
      }
      else -> null
    }
    if (source == null && !dirty) return
    if (!beginWindow()) return
    dirty = false
    clearWindow(0f, 0f, 0f, 1f)
    val signal = source?.let { renderer.ingest(it) }
    if (source != null && signal != null) {
      val (sw, sh) = source.size
      lastWidth = sw
      lastHeight = sh
      val lut = PocketVideoLutRegistry.lut(fx.lutId)
      val u = PocketVideoFxUniforms.make(fx, lut, sw, sh, surfaceWidth.toDouble(), surfaceHeight.toDouble(), density, fill)
      renderer.picture(0, surfaceWidth, surfaceHeight, signal, fx, lut, u)
      s?.lastEffects = fx
      presentedInWindow++
    } else {
      clearWindow(0f, 0f, 0f, 1f)
    }
    endWindow()
  }

  private fun emitStatsIfDue(now: Long) {
    val elapsed = (now - windowStartNanos) / 1e9
    if (elapsed < 1.0) return
    val s = session
    val decoded = s?.decodedTotal ?: 0L
    val decodedFps = if (s == null) 0.0 else (decoded - decodedAtWindowStart) / elapsed
    val presentedFps = presentedInWindow / elapsed
    val age = if (s != null && s.frameArrivedNanos > 0) (now - s.frameArrivedNanos) / 1e6 else -1.0
    windowStartNanos = now
    presentedInWindow = 0
    decodedAtWindowStart = decoded
    val payload: Map<String, Any> = mapOf(
      "width" to lastWidth,
      "height" to lastHeight,
      "presentedFps" to Math.round(presentedFps * 10) / 10.0,
      "decodedFps" to Math.round(decodedFps * 10) / 10.0,
      "droppedFrames" to ((s?.droppedTotal ?: 0L) + superseded).toDouble(),
      "lastFrameAgeMs" to if (age < 0) -1.0 else Math.round(age).toDouble(),
    )
    post { onFrameStats(payload) }
  }
}
