package com.favdevs.opcnative.datalink

/**
 * Pure DUML-over-UDP byte math for the datalink threads. Port of
 * `Sources/OpenPocketViewCore/DumlTransport.swift` / `DumlFrame.swift`, with the newer upstream
 * forward-only ACK window merge (`src/core/transport/datalink.ts`). Bytes are unsigned via `and 0xFF`.
 */
internal object DumlWire {
  const val PKT_HANDSHAKE = 0x00
  const val PKT_TELEMETRY = 0x01
  const val PKT_VIDEO = 0x02
  const val PKT_ACKED_DATA = 0x03
  const val PKT_ACK = 0x04
  const val PKT_COMMAND = 0x05

  fun u8(b: ByteArray, i: Int): Int = b[i].toInt() and 0xFF
  fun u16(b: ByteArray, i: Int): Int = u8(b, i) or (u8(b, i + 1) shl 8)

  fun pktType(d: ByteArray, length: Int = d.size): Int = if (length >= 8) u8(d, 6) else -1

  fun transportSeq(d: ByteArray, length: Int = d.size): Int? = if (length >= 6) u16(d, 4) else null

  /** `[u16le 0x8000|total][u16le session][u16le seq][u8 pktType][u8 xor]`, total = 8 + payloadLen. */
  fun transportHeader(pktType: Int, payloadLen: Int, sessionId: Int, seq: Int): ByteArray {
    val total = 8 + payloadLen
    val w0 = 0x8000 or (total and 0x3FFF)
    val b = ByteArray(8)
    b[0] = (w0 and 0xFF).toByte()
    b[1] = ((w0 shr 8) and 0xFF).toByte()
    b[2] = (sessionId and 0xFF).toByte()
    b[3] = ((sessionId shr 8) and 0xFF).toByte()
    b[4] = (seq and 0xFF).toByte()
    b[5] = ((seq shr 8) and 0xFF).toByte()
    b[6] = (pktType and 0xFF).toByte()
    var x = 0
    for (i in 0 until 7) x = x xor (b[i].toInt() and 0xFF)
    b[7] = x.toByte()
    return b
  }

  /** 12-byte routing header: `[u16le seq-8][u16le seq][00 00 00 00][counter][01][00][00]`. */
  fun routingHeader(seq: Int, cmdCounter: Int): ByteArray {
    val ack = (seq - 8) and 0xFFFF
    return byteArrayOf(
      (ack and 0xFF).toByte(), ((ack shr 8) and 0xFF).toByte(),
      (seq and 0xFF).toByte(), ((seq shr 8) and 0xFF).toByte(),
      0, 0, 0, 0, (cmdCounter and 0xFF).toByte(), 0x01, 0x00, 0x00,
    )
  }

  /** 26-byte pktType-0x04 payload: `grp(video) + grp(ackedData) + grp(extra) + [0,0]`. */
  fun ackPayload(video: Int, ackedData: Int, extra: Int): ByteArray {
    val out = ByteArray(26)
    fun grp(at: Int, v: Int) {
      out[at] = (v and 0xFF).toByte()
      out[at + 1] = ((v shr 8) and 0xFF).toByte()
      out[at + 2] = (v and 0xFF).toByte()
      out[at + 3] = ((v shr 8) and 0xFF).toByte()
    }
    grp(0, video)
    grp(8, ackedData)
    grp(16, extra)
    return out
  }

  data class HandshakeInfo(val sessionId: Int, val seq: Int, val baseSeq: Int)

  /** A JS-built handshake (`sendRaw`): pktType 0x00, payload[0..1] = baseSeq. */
  fun parseOutgoingHandshake(d: ByteArray): HandshakeInfo? {
    if (d.size < 10 || u8(d, 6) != PKT_HANDSHAKE) return null
    return HandshakeInfo(u16(d, 2), u16(d, 4), u16(d, 8))
  }

  /** 34-byte `0x01` initial window → first command seq. */
  fun controlSequence(d: ByteArray, length: Int): Int? {
    if (length != 34 || u8(d, 6) != PKT_TELEMETRY) return null
    return (u16(d, 8) + 8) and 0xFFFF
  }

  fun isForward(candidate: Int, current: Int): Boolean {
    val delta = (candidate - current) and 0xFFFF
    return delta != 0 && delta < 0x8000
  }

  // Reflected CRC-8, init 0x77, poly 0x8C.
  fun crc8(d: ByteArray, from: Int, to: Int): Int {
    var c = 0x77
    for (i in from until to) {
      c = c xor (d[i].toInt() and 0xFF)
      repeat(8) { c = if ((c and 1) != 0) (c ushr 1) xor 0x8C else c ushr 1 }
    }
    return c and 0xFF
  }

  // Reflected CRC-16, init 0x3692, poly 0x8408.
  fun crc16(d: ByteArray, from: Int, to: Int): Int {
    var c = 0x3692
    for (i in from until to) {
      c = c xor (d[i].toInt() and 0xFF)
      repeat(8) { c = if ((c and 1) != 0) (c ushr 1) xor 0x8408 else c ushr 1 }
    }
    return c and 0xFFFF
  }

  /** Every CRC-valid DUML frame in `d[0 until length]` (byte-at-a-time scan, both CRCs checked). */
  fun scanFrames(d: ByteArray, length: Int): List<ByteArray> {
    val out = ArrayList<ByteArray>(2)
    var i = 0
    while (i + 13 <= length) {
      if (u8(d, i) != 0x55) {
        i += 1
        continue
      }
      val total = u8(d, i + 1) or ((u8(d, i + 2) and 0x03) shl 8)
      if ((u8(d, i + 2) shr 2) != 1 || total < 13 || i + total > length) {
        i += 1
        continue
      }
      if (crc8(d, i, i + 3) != u8(d, i + 3)) {
        i += 1
        continue
      }
      val end = i + total
      val got = u8(d, end - 2) or (u8(d, end - 1) shl 8)
      if (crc16(d, i, end - 2) != got) {
        i += 1
        continue
      }
      out.add(d.copyOfRange(i, end))
      i += 1
    }
    return out
  }
}

/**
 * The three camera send windows echoed by every ACK (CONTEXT.md "ACK window"). Group 0 = latest
 * video `0x02` seq (telemetry seeds it only before the first `0x02`), group 1 = ackedData `0x03`
 * (forward-only merge with telemetry), group 2 = telemetry extra. Unseen groups 1/2 fall back to
 * the handshake `baseSeq`. Not thread-safe: guarded by the session's wire lock.
 */
internal class AckWindows {
  var video = 0
  var hasVideoSeq = false
  var hasGroup0 = false
  var ackedData = 0
  var hasAckedData = false
  var extra = 0
  var hasExtra = false

  fun reset() {
    video = 0; hasVideoSeq = false; hasGroup0 = false
    ackedData = 0; hasAckedData = false
    extra = 0; hasExtra = false
  }

  private fun advanceAckedData(candidate: Int) {
    if (!hasAckedData || candidate == ackedData || DumlWire.isForward(candidate, ackedData)) {
      ackedData = candidate
      hasAckedData = true
    }
  }

  fun note(d: ByteArray, length: Int) {
    if (length < 8) return
    when (DumlWire.u8(d, 6)) {
      DumlWire.PKT_TELEMETRY -> if (length >= 34) {
        if (length == 34 && !hasVideoSeq) {
          video = DumlWire.u16(d, 10)
          hasGroup0 = true
        }
        advanceAckedData(DumlWire.u16(d, 18))
        extra = DumlWire.u16(d, 26)
        hasExtra = true
      }
      DumlWire.PKT_ACKED_DATA -> advanceAckedData(DumlWire.u16(d, 4))
    }
  }

  fun noteVideo(seq: Int) {
    video = seq
    hasVideoSeq = true
    hasGroup0 = true
  }

  fun payload(baseSeq: Int): ByteArray = DumlWire.ackPayload(
    if (hasGroup0) video else 0,
    if (hasAckedData) ackedData else baseSeq,
    if (hasExtra) extra else baseSeq,
  )
}

/** `DatalinkHandshakeAdmission`: the 0x00 ACK plus the 34-byte 0x01 initial command window. */
internal class HandshakeAdmission {
  var acknowledged = false
    private set
  private var window: Int? = null

  fun reset() {
    acknowledged = false
    window = null
  }

  fun receive(d: ByteArray, length: Int) {
    if (length >= 8 && DumlWire.u8(d, 6) == DumlWire.PKT_HANDSHAKE) acknowledged = true
    if (window == null) window = DumlWire.controlSequence(d, length)
  }

  val initialCommandSequence: Int? get() = if (acknowledged) window else null
}
