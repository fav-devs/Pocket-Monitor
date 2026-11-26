package com.favdevs.opcnative.video

import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES30
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Choreographer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Something the GL thread drives once per vsync (a picture or scope view). */
interface OpcGlTarget {
  /** Called on the GL thread with the Choreographer frame time. */
  fun onGlFrame(frameTimeNanos: Long)
}

/**
 * The single GL thread. One EGL context serves every view, every session's decoder texture and
 * every LUT, so textures are shared without context sharing. Views render into their own
 * window surfaces (`eglMakeCurrent` per target); offscreen work uses a 1×1 pbuffer.
 *
 * A Choreographer on this thread paces presentation: each vsync every registered target may
 * draw (latest frame wins).
 */
object OpcVideoGl {
  private const val TAG = "OpcVideoGl"
  private val thread = HandlerThread("opc-video-gl", android.os.Process.THREAD_PRIORITY_DISPLAY).apply { start() }
  val handler = Handler(thread.looper)

  // GL-thread confined below.
  var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private set
  private var config: EGLConfig? = null
  private var context: EGLContext = EGL14.EGL_NO_CONTEXT
  private var pbuffer: EGLSurface = EGL14.EGL_NO_SURFACE
  private val targets = LinkedHashSet<OpcGlTarget>()
  private var choreographer: Choreographer? = null
  private var looping = false
  var programs: OpcVideoPrograms? = null
    private set

  val isGlThread: Boolean get() = Thread.currentThread() === thread

  fun post(block: () -> Unit) {
    handler.post {
      try {
        ensureContext()
        block()
      } catch (t: Throwable) {
        Log.e(TAG, "GL task failed", t)
      }
    }
  }

  /** Runs on the GL thread and waits (bounded). Never call from the GL thread itself. */
  fun <T> sync(timeoutMs: Long = 1000, block: () -> T): T? {
    if (isGlThread) return block()
    var result: T? = null
    val latch = CountDownLatch(1)
    post {
      try {
        result = block()
      } finally {
        latch.countDown()
      }
    }
    latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    return result
  }

  fun register(target: OpcGlTarget) = post {
    targets.add(target)
    startLoop()
  }

  fun unregister(target: OpcGlTarget) = post { targets.remove(target) }

  private val frameCallback = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      if (targets.isEmpty()) {
        looping = false
        return
      }
      for (target in targets.toList()) {
        try {
          target.onGlFrame(frameTimeNanos)
        } catch (t: Throwable) {
          Log.e(TAG, "target frame failed", t)
        }
      }
      choreographer?.postFrameCallback(this)
    }
  }

  private fun startLoop() {
    if (looping) return
    looping = true
    val c = choreographer ?: Choreographer.getInstance().also { choreographer = it }
    c.postFrameCallback(frameCallback)
  }

  // ─── EGL ───────────────────────────────────────────────────────────────────────────

  private fun ensureContext() {
    if (context != EGL14.EGL_NO_CONTEXT) return
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    val version = IntArray(2)
    check(EGL14.eglInitialize(display, version, 0, version, 1)) { "eglInitialize failed" }
    val attribs = intArrayOf(
      EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
      EGL14.EGL_RENDERABLE_TYPE, EGLExt.EGL_OPENGL_ES3_BIT_KHR,
      EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
      EGL14.EGL_NONE,
    )
    val configs = arrayOfNulls<EGLConfig>(1)
    val count = IntArray(1)
    check(EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, count, 0) && count[0] > 0) { "no ES3 config" }
    config = configs[0]
    context = EGL14.eglCreateContext(
      display, config, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE), 0,
    )
    check(context != EGL14.EGL_NO_CONTEXT) { "eglCreateContext failed" }
    pbuffer = EGL14.eglCreatePbufferSurface(display, config, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
    makeOffscreenCurrent()
    programs = OpcVideoPrograms()
  }

  fun makeOffscreenCurrent() {
    EGL14.eglMakeCurrent(display, pbuffer, pbuffer, context)
  }

  fun createWindowSurface(texture: SurfaceTexture): EGLSurface {
    ensureContext()
    return EGL14.eglCreateWindowSurface(display, config, texture, intArrayOf(EGL14.EGL_NONE), 0)
  }

  fun makeCurrent(surface: EGLSurface): Boolean = EGL14.eglMakeCurrent(display, surface, surface, context)

  fun swap(surface: EGLSurface): Boolean = EGL14.eglSwapBuffers(display, surface)

  fun destroySurface(surface: EGLSurface) {
    makeOffscreenCurrent()
    EGL14.eglDestroySurface(display, surface)
  }
}

/** A colour texture plus framebuffer. */
class OpcGlFbo(val width: Int, val height: Int, internalFormat: Int = GLES30.GL_RGBA8) {
  val texture: Int
  val framebuffer: Int

  init {
    val ids = IntArray(1)
    GLES30.glGenTextures(1, ids, 0)
    texture = ids[0]
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texture)
    GLES30.glTexStorage2D(GLES30.GL_TEXTURE_2D, 1, internalFormat, width, height)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
    GLES30.glGenFramebuffers(1, ids, 0)
    framebuffer = ids[0]
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, framebuffer)
    GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, texture, 0)
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
  }

  fun bind() {
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, framebuffer)
    GLES30.glViewport(0, 0, width, height)
  }

  fun release() {
    GLES30.glDeleteFramebuffers(1, intArrayOf(framebuffer), 0)
    GLES30.glDeleteTextures(1, intArrayOf(texture), 0)
  }
}

/** One linked program with cached uniform locations. */
class OpcGlProgram(vertex: String, fragment: String) {
  val id: Int
  private val locations = HashMap<String, Int>()

  init {
    val vs = compile(GLES30.GL_VERTEX_SHADER, vertex)
    val fs = compile(GLES30.GL_FRAGMENT_SHADER, fragment)
    id = GLES30.glCreateProgram()
    GLES30.glAttachShader(id, vs)
    GLES30.glAttachShader(id, fs)
    GLES30.glLinkProgram(id)
    val ok = IntArray(1)
    GLES30.glGetProgramiv(id, GLES30.GL_LINK_STATUS, ok, 0)
    if (ok[0] == 0) {
      val log = GLES30.glGetProgramInfoLog(id)
      GLES30.glDeleteProgram(id)
      throw IllegalStateException("link failed: $log")
    }
    GLES30.glDeleteShader(vs)
    GLES30.glDeleteShader(fs)
  }

  fun use() = GLES30.glUseProgram(id)

  fun loc(name: String): Int = locations.getOrPut(name) { GLES30.glGetUniformLocation(id, name) }

  private fun compile(type: Int, source: String): Int {
    val shader = GLES30.glCreateShader(type)
    GLES30.glShaderSource(shader, source)
    GLES30.glCompileShader(shader)
    val ok = IntArray(1)
    GLES30.glGetShaderiv(shader, GLES30.GL_COMPILE_STATUS, ok, 0)
    if (ok[0] == 0) {
      val log = GLES30.glGetShaderInfoLog(shader)
      GLES30.glDeleteShader(shader)
      throw IllegalStateException("compile failed: $log")
    }
    return shader
  }
}

/** Every program, compiled once on the GL thread. */
class OpcVideoPrograms {
  val ingestOes = OpcGlProgram(OpcVideoShaders.VERTEX, OpcVideoShaders.INGEST_OES)
  val ingestDemo = OpcGlProgram(OpcVideoShaders.VERTEX, OpcVideoShaders.INGEST_DEMO)
  val peakBlur = OpcGlProgram(OpcVideoShaders.VERTEX, OpcVideoShaders.PEAK_BLUR)
  val peakMask = OpcGlProgram(OpcVideoShaders.VERTEX, OpcVideoShaders.PEAK_MASK)
  val picture = OpcGlProgram(OpcVideoShaders.VERTEX, OpcVideoShaders.PICTURE)
  val measure = OpcGlProgram(OpcVideoShaders.VERTEX, OpcVideoShaders.MEASURE)
  val scopeDraw = OpcGlProgram(OpcVideoShaders.VERTEX, OpcVideoShaders.SCOPE_DRAW)
  val blit = OpcGlProgram(OpcVideoShaders.VERTEX, OpcVideoShaders.BLIT)

  /** 2×2×2 identity cube bound when no LUT is active. */
  val identityLut: Int
  /** 1×1 black mask bound when peaking is off. */
  val emptyMask: Int
  /** Empty VAO: the full-screen triangle uses gl_VertexID only. */
  val vao: Int

  init {
    val ids = IntArray(1)
    GLES30.glGenTextures(1, ids, 0)
    identityLut = ids[0]
    GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, identityLut)
    val cube = java.nio.ByteBuffer.allocateDirect(32)
    for (b in 0..1) for (g in 0..1) for (r in 0..1) {
      cube.put((r * 255).toByte()); cube.put((g * 255).toByte()); cube.put((b * 255).toByte()); cube.put(255.toByte())
    }
    cube.position(0)
    GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
    GLES30.glTexImage3D(GLES30.GL_TEXTURE_3D, 0, GLES30.GL_RGBA8, 2, 2, 2, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, cube)
    setLinear3D()
    GLES30.glGenTextures(1, ids, 0)
    emptyMask = ids[0]
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, emptyMask)
    val black = java.nio.ByteBuffer.allocateDirect(4)
    GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, 1, 1, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, black)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_NEAREST)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_NEAREST)
    GLES30.glGenVertexArrays(1, ids, 0)
    vao = ids[0]
  }

  companion object {
    fun setLinear3D() {
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_R, GLES30.GL_CLAMP_TO_EDGE)
    }
  }
}
