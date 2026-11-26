package com.favdevs.opcnative.video

import android.opengl.GLES30
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap

/** A registered 3D LUT texture in the shared GL context (red fastest, as in the .cube). */
class OpcVideoLut(
  val id: String,
  val size: Int,
  val domainMin: FloatArray,
  val domainMax: FloatArray,
  /** GL_TEXTURE_3D name; valid on the GL thread only. */
  val texture: Int,
)

class OpcVideoLutException(message: String) : Exception(message)

/** Adobe/Resolve `.cube` parser. */
class OpcVideoCube(val size: Int, val domainMin: FloatArray, val domainMax: FloatArray, val rgb: FloatArray) {
  companion object {
    fun parse(text: String): OpcVideoCube {
      var size = 0
      var domainMin = floatArrayOf(0f, 0f, 0f)
      var domainMax = floatArrayOf(1f, 1f, 1f)
      var values = FloatArray(33 * 33 * 33 * 3)
      var count = 0
      var lineNumber = 0
      for (raw in text.lineSequence()) {
        lineNumber++
        val line = raw.substringBefore('#').trim()
        if (line.isEmpty()) continue
        val parts = line.split(' ', '\t').filter { it.isNotEmpty() }
        if (line[0].isLetter()) {
          when (parts[0].uppercase()) {
            "LUT_3D_SIZE" -> {
              val n = parts.getOrNull(1)?.toIntOrNull() ?: throw OpcVideoLutException("Unreadable LUT_3D_SIZE on line $lineNumber.")
              if (n !in 2..129) throw OpcVideoLutException("Unsupported LUT_3D_SIZE $n (2…129).")
              size = n
              if (values.size < n * n * n * 3) values = FloatArray(n * n * n * 3)
            }
            "LUT_1D_SIZE" -> throw OpcVideoLutException("1D .cube files are not supported.")
            "DOMAIN_MIN" -> domainMin = triple(parts, lineNumber)
            "DOMAIN_MAX" -> domainMax = triple(parts, lineNumber)
            else -> Unit // TITLE, LUT_3D_INPUT_RANGE, vendor keys
          }
          continue
        }
        if (parts.size < 3) throw OpcVideoLutException("Unreadable row on line $lineNumber.")
        if (count + 3 > values.size) throw OpcVideoLutException("Too many table rows (line $lineNumber).")
        for (k in 0..2) {
          values[count++] = parts[k].toFloatOrNull() ?: throw OpcVideoLutException("Unreadable number on line $lineNumber.")
        }
      }
      if (size < 2) throw OpcVideoLutException("Not a 3D .cube (LUT_3D_SIZE missing).")
      val expected = size * size * size
      if (count / 3 != expected) throw OpcVideoLutException("Expected $expected table rows, found ${count / 3}.")
      return OpcVideoCube(size, domainMin, domainMax, values.copyOf(expected * 3))
    }

    private fun triple(parts: List<String>, line: Int): FloatArray {
      val v = parts.drop(1).take(3).mapNotNull { it.toFloatOrNull() }
      if (v.size != 3) throw OpcVideoLutException("Unreadable domain on line $line.")
      return v.toFloatArray()
    }
  }
}

/** Process-wide LUT registry shared by every view. */
object OpcVideoLutRegistry {
  private val luts = ConcurrentHashMap<String, OpcVideoLut>()

  fun lut(id: String?): OpcVideoLut? = id?.let { luts[it] }

  /** Parses on the caller's thread, uploads on the GL thread; returns the cube size. */
  fun load(id: String, cubeText: String): Int {
    val cube = OpcVideoCube.parse(cubeText)
    val n = cube.size
    val texture = OpcVideoGl.sync(5000) {
      val ids = IntArray(1)
      GLES30.glGenTextures(1, ids, 0)
      GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, ids[0])
      val data = ByteBuffer.allocateDirect(n * n * n * 4 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
      for (i in 0 until n * n * n) {
        data.put(cube.rgb[i * 3]); data.put(cube.rgb[i * 3 + 1]); data.put(cube.rgb[i * 3 + 2]); data.put(1f)
      }
      data.position(0)
      GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 4)
      // RGBA16F is filterable on every ES 3.0 device; float source data is converted by GL.
      GLES30.glTexImage3D(GLES30.GL_TEXTURE_3D, 0, GLES30.GL_RGBA16F, n, n, n, 0, GLES30.GL_RGBA, GLES30.GL_FLOAT, data)
      OpcVideoPrograms.setLinear3D()
      ids[0]
    } ?: throw OpcVideoLutException("GL upload timed out.")
    luts.put(id, OpcVideoLut(id, n, cube.domainMin, cube.domainMax, texture))?.let { old ->
      OpcVideoGl.post { GLES30.glDeleteTextures(1, intArrayOf(old.texture), 0) }
    }
    return n
  }

  fun unload(id: String) {
    val old = luts.remove(id) ?: return
    OpcVideoGl.post { GLES30.glDeleteTextures(1, intArrayOf(old.texture), 0) }
  }
}
