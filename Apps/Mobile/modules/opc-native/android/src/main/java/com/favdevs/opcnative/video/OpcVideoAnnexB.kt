package com.favdevs.opcnative.video

import com.favdevs.opcnative.shared.OpcVideoCodec

/**
 * Annex-B splitting, NAL classification and SPS picture size. Mirrors OpenPocketViewCore
 * Hevc.swift / Avc.swift (DJI marker type 63 and Nano SEI 0xF0 rules) and iOS OpcVideoAnnexB.
 */
object OpcVideoAnnexB {
  class Nal(val offset: Int, val length: Int, val type: Int)

  fun nals(b: ByteArray, codec: OpcVideoCodec): List<Nal> {
    val n = b.size
    val starts = ArrayList<Int>()
    val skipped = HashSet<Int>()
    var i = 0
    while (i + 3 <= n) {
      if (b[i].toInt() == 0 && b[i + 1].toInt() == 0 && b[i + 2].toInt() == 1) {
        starts.add(i + 3)
        if (i + 32 <= n && b[i + 3].toInt() == 6 && (b[i + 4].toInt() and 0xff) == 0xF0 &&
          b[i + 5].toInt() == 25 && (b[i + 31].toInt() and 0xff) == 0x80
        ) {
          skipped.add(i + 3)
          i += 32
        } else {
          i += 3
        }
      } else {
        i += 1
      }
    }
    val out = ArrayList<Nal>(starts.size)
    for ((k, s) in starts.withIndex()) {
      if (s in skipped) continue
      var e = if (k + 1 < starts.size) starts[k + 1] - 3 else n
      while (e > s && b[e - 1].toInt() == 0) e--
      if (e <= s) continue
      out.add(Nal(s, e - s, nalType(b[s], codec)))
    }
    return out
  }

  fun nalType(first: Byte, codec: OpcVideoCodec): Int {
    val v = first.toInt() and 0xff
    return if (codec == OpcVideoCodec.HEVC) (v shr 1) and 0x3f else v and 0x1f
  }

  fun isParameterSet(t: Int, codec: OpcVideoCodec) =
    if (codec == OpcVideoCodec.HEVC) t in 32..34 else t == 7 || t == 8

  fun isVcl(t: Int, codec: OpcVideoCodec) = if (codec == OpcVideoCodec.HEVC) t <= 31 else t in 1..5

  fun isRandomAccess(t: Int, codec: OpcVideoCodec) = if (codec == OpcVideoCodec.HEVC) t in 16..21 else t == 5

  fun carriesKeyframe(b: ByteArray, codec: OpcVideoCodec): Boolean =
    nals(b, codec).any { isRandomAccess(it.type, codec) || isParameterSet(it.type, codec) }

  // ─── SPS picture size ────────────────────────────────────────────────────────────────

  /** Exp-Golomb reader over an RBSP (emulation prevention removed). */
  private class Bits(nal: ByteArray, offset: Int, length: Int) {
    private val data: ByteArray
    private var pos = 0

    init {
      val out = java.io.ByteArrayOutputStream(length)
      var zeros = 0
      for (i in offset until offset + length) {
        val v = nal[i].toInt() and 0xff
        if (zeros >= 2 && v == 3) {
          zeros = 0
          continue
        }
        out.write(v)
        zeros = if (v == 0) zeros + 1 else 0
      }
      data = out.toByteArray()
    }

    fun u(n: Int): Long {
      var v = 0L
      repeat(n) {
        val byte = pos ushr 3
        if (byte >= data.size) throw IndexOutOfBoundsException()
        v = (v shl 1) or (((data[byte].toInt() ushr (7 - (pos and 7))) and 1).toLong())
        pos++
      }
      return v
    }

    fun skip(n: Int) { pos += n }

    fun ue(): Int {
      var zeros = 0
      while (u(1) == 0L) {
        zeros++
        if (zeros > 31) throw IllegalStateException("bad ue")
      }
      return ((1L shl zeros) - 1 + u(zeros)).toInt()
    }

    fun se(): Int {
      val k = ue()
      return if (k and 1 == 1) (k + 1) / 2 else -(k / 2)
    }
  }

  /** Cropped luma size from an SPS NAL (header included), or null when it cannot be parsed. */
  fun spsSize(nal: ByteArray, offset: Int, length: Int, codec: OpcVideoCodec): Pair<Int, Int>? = try {
    if (codec == OpcVideoCodec.HEVC) hevcSize(Bits(nal, offset + 2, length - 2)) else avcSize(Bits(nal, offset + 1, length - 1))
  } catch (_: Exception) {
    null
  }

  private fun hevcSize(r: Bits): Pair<Int, Int> {
    r.skip(4) // vps id
    val maxSubLayersMinus1 = r.u(3).toInt()
    r.skip(1)
    // profile_tier_level(1, maxSubLayersMinus1)
    r.skip(88)
    r.skip(8) // general_level_idc
    val profilePresent = BooleanArray(maxSubLayersMinus1)
    val levelPresent = BooleanArray(maxSubLayersMinus1)
    for (i in 0 until maxSubLayersMinus1) {
      profilePresent[i] = r.u(1) == 1L
      levelPresent[i] = r.u(1) == 1L
    }
    if (maxSubLayersMinus1 > 0) for (i in maxSubLayersMinus1 until 8) r.skip(2)
    for (i in 0 until maxSubLayersMinus1) {
      if (profilePresent[i]) r.skip(88)
      if (levelPresent[i]) r.skip(8)
    }
    r.ue() // sps id
    val chroma = r.ue()
    if (chroma == 3) r.skip(1)
    var width = r.ue()
    var height = r.ue()
    if (r.u(1) == 1L) {
      val subW = if (chroma == 1 || chroma == 2) 2 else 1
      val subH = if (chroma == 1) 2 else 1
      val l = r.ue(); val rr = r.ue(); val t = r.ue(); val b = r.ue()
      width -= subW * (l + rr)
      height -= subH * (t + b)
    }
    return width to height
  }

  private fun avcSize(r: Bits): Pair<Int, Int> {
    val profile = r.u(8).toInt()
    r.skip(16) // constraints + level
    r.ue() // sps id
    var chroma = 1
    if (profile in intArrayOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135)) {
      chroma = r.ue()
      if (chroma == 3) r.skip(1)
      r.ue(); r.ue() // bit depths
      r.skip(1)
      if (r.u(1) == 1L) {
        val lists = if (chroma != 3) 8 else 12
        for (i in 0 until lists) {
          if (r.u(1) == 1L) {
            val size = if (i < 6) 16 else 64
            var last = 8
            var next = 8
            for (j in 0 until size) {
              if (next != 0) next = (last + r.se() + 256) % 256
              last = if (next == 0) last else next
            }
          }
        }
      }
    }
    r.ue() // log2_max_frame_num_minus4
    when (r.ue()) {
      0 -> r.ue()
      1 -> {
        r.skip(1); r.se(); r.se()
        repeat(r.ue()) { r.se() }
      }
    }
    r.ue() // max_num_ref_frames
    r.skip(1)
    val widthMbs = r.ue() + 1
    val heightUnits = r.ue() + 1
    val frameMbsOnly = r.u(1).toInt()
    if (frameMbsOnly == 0) r.skip(1)
    r.skip(1)
    var width = widthMbs * 16
    var height = (2 - frameMbsOnly) * heightUnits * 16
    if (r.u(1) == 1L) {
      val cropX = if (chroma == 0 || chroma == 3) 1 else 2
      val cropY = (if (chroma == 1) 2 else 1) * (2 - frameMbsOnly)
      val l = r.ue(); val rr = r.ue(); val t = r.ue(); val b = r.ue()
      width -= cropX * (l + rr)
      height -= cropY * (t + b)
    }
    return width to height
  }
}
