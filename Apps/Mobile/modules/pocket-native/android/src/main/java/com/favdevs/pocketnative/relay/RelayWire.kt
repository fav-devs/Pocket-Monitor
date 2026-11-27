package com.favdevs.pocketnative.relay

import android.util.Base64
import com.favdevs.pocketnative.shared.PocketVideoCodec
import com.favdevs.pocketnative.video.PocketVideoAnnexB
import java.io.DataInputStream
import java.io.IOException
import org.json.JSONArray
import org.json.JSONObject

/**
 * Watcher relay wire (docs/watcher-relay.md; JS mirror and tests in src/camera/watcher/protocol.ts):
 * `[u32be payload length + 1][u8 kind][payload]`, JSON control messages, and frame payloads
 * `[u32be meta length][meta JSON][Annex-B access unit]`.
 */
internal object RelayWire {
  const val SERVICE_TYPE = "_pocket-mon._tcp"
  const val LEGACY_SERVICE_TYPE = "_opc-mon._tcp"
  val BROWSE_TYPES = listOf(SERVICE_TYPE, LEGACY_SERVICE_TYPE)
  const val VERSION = 1
  const val MAX_PAYLOAD = 8 * 1024 * 1024
  /** Watcher → host messages are tiny (hello, control, commands). */
  const val MAX_WATCHER_PAYLOAD = 64 * 1024
  const val HEADER = 5
  const val TXT_CAMERA = "c"
  const val TXT_WATCHABLE = "w"
  const val HEVC_CODEC = 1
  /** Pocket Monitor extension for a forwarded Nano (AVC) feed; upstream watchers take only 1. */
  const val AVC_CODEC = 2

  const val HELLO = 0x01
  const val STATE = 0x02
  const val FRAME = 0x03
  const val TOKEN = 0x04
  const val DENIED = 0x05
  const val REQUEST_CONTROL = 0x10
  const val RELEASE_CONTROL = 0x11
  const val COMMAND = 0x12
  private val KINDS = setOf(HELLO, STATE, FRAME, TOKEN, DENIED, REQUEST_CONTROL, RELEASE_CONTROL, COMMAND)

  const val VERSION_MISMATCH = "Update the app on both devices to watch this feed."
  const val WRONG_PASSCODE = "Wrong passcode."
  const val FELL_BEHIND = "The shared feed fell behind live delivery."

  /** Monotonic seconds (host `encodedAt`, watcher freshness). */
  fun now(): Double = System.nanoTime() / 1e9

  fun header(kind: Int, payloadLength: Int): ByteArray {
    val declared = payloadLength + 1
    return byteArrayOf(
      (declared ushr 24).toByte(),
      (declared ushr 16).toByte(),
      (declared ushr 8).toByte(),
      declared.toByte(),
      kind.toByte(),
    )
  }

  fun message(kind: Int, payload: ByteArray): ByteArray = header(kind, payload.size) + payload

  fun message(kind: Int, json: JSONObject): ByteArray = message(kind, json.toString().toByteArray(Charsets.UTF_8))

  class ProtocolException(message: String) : IOException(message)

  class Message(val kind: Int, val payload: ByteArray)

  /** Blocking read of one message. Refuses unknown kinds and oversized payloads. */
  fun read(input: DataInputStream, maxPayload: Int): Message {
    val declared = input.readInt()
    if (declared < 1 || declared - 1 > maxPayload) throw ProtocolException("relay payload too large ($declared)")
    val kind = input.readUnsignedByte()
    if (kind !in KINDS) throw ProtocolException("unknown relay kind $kind")
    val payload = ByteArray(declared - 1)
    input.readFully(payload)
    return Message(kind, payload)
  }

  fun hello(hostName: String, cameraName: String?): JSONObject = JSONObject().apply {
    put("version", VERSION)
    put("hostName", hostName)
    if (!cameraName.isNullOrEmpty()) put("cameraName", cameraName)
  }

  fun denied(reason: String, passcodeRequired: Boolean): JSONObject = JSONObject().apply {
    put("reason", reason)
    put("passcodeRequired", passcodeRequired)
  }

  fun token(holderName: String, recipient: Boolean): JSONObject = JSONObject().apply {
    put("holderName", holderName)
    put("holderIsRecipient", recipient)
  }

  /** Frame message header bytes (everything before the access unit), so the AU is never copied. */
  fun frameHead(
    codec: PocketVideoCodec,
    keyframe: Boolean,
    parameterSets: List<ByteArray>?,
    recording: Boolean,
    mirrored: Boolean,
    encodedAt: Double,
    catchUp: Boolean,
    accessUnitLength: Int,
  ): ByteArray {
    val meta = JSONObject().apply {
      put("codec", if (codec == PocketVideoCodec.AVC) AVC_CODEC else HEVC_CODEC)
      put("isKeyframe", keyframe)
      if (keyframe && !parameterSets.isNullOrEmpty()) {
        put("parameterSets", JSONArray().apply { parameterSets.forEach { put(Base64.encodeToString(it, Base64.NO_WRAP)) } })
      }
      put("isRecording", recording)
      put("extraMirrored", mirrored)
      put("encodedAt", encodedAt)
      if (catchUp) put("catchUp", true)
    }.toString().toByteArray(Charsets.UTF_8)
    val payloadLength = 4 + meta.size + accessUnitLength
    val n = meta.size
    return header(FRAME, payloadLength) +
      byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte()) +
      meta
  }

  class Frame(
    val codec: PocketVideoCodec,
    val keyframe: Boolean,
    val parameterSets: List<ByteArray>,
    val encodedAt: Double?,
    val catchUp: Boolean,
    val accessUnit: ByteArray,
  )

  fun decodeFrame(payload: ByteArray): Frame? {
    if (payload.size < 4) return null
    val n = ((payload[0].toInt() and 0xff) shl 24) or ((payload[1].toInt() and 0xff) shl 16) or
      ((payload[2].toInt() and 0xff) shl 8) or (payload[3].toInt() and 0xff)
    if (n < 0 || 4 + n > payload.size) return null
    val meta = runCatching { JSONObject(String(payload, 4, n, Charsets.UTF_8)) }.getOrNull() ?: return null
    if (!meta.has("codec") || !meta.has("isKeyframe")) return null
    val codec = when (meta.optInt("codec", HEVC_CODEC)) {
      HEVC_CODEC -> PocketVideoCodec.HEVC
      AVC_CODEC -> PocketVideoCodec.AVC
      else -> return null
    }
    val sets = meta.optJSONArray("parameterSets")?.let { a ->
      (0 until a.length()).mapNotNull { i -> runCatching { Base64.decode(a.getString(i), Base64.DEFAULT) }.getOrNull() }
    } ?: emptyList()
    val encodedAt = if (meta.has("encodedAt") && !meta.isNull("encodedAt")) meta.optDouble("encodedAt").takeIf { it.isFinite() } else null
    return Frame(
      codec = codec,
      keyframe = meta.optBoolean("isKeyframe"),
      parameterSets = sets,
      encodedAt = encodedAt,
      catchUp = meta.optBoolean("catchUp", false),
      accessUnit = payload.copyOfRange(4 + n, payload.size),
    )
  }

  private val START = byteArrayOf(0, 0, 0, 1)

  /** `sets` as Annex-B in front of `au`. */
  fun prefixed(sets: List<ByteArray>, au: ByteArray): ByteArray {
    var out = ByteArray(0)
    for (s in sets) out += START + s
    return out + au
  }

  class Classified(val keyframe: Boolean, val parameterSets: List<ByteArray>, val hasParameterSets: Boolean)

  /** Random access and the parameter sets an AU carries (HEVC VPS/SPS/PPS, AVC SPS/PPS, in order). */
  fun classify(au: ByteArray, codec: PocketVideoCodec): Classified {
    var key = false
    val sets = mutableListOf<ByteArray>()
    for (nal in PocketVideoAnnexB.nals(au, codec)) {
      if (PocketVideoAnnexB.isParameterSet(nal.type, codec)) sets += au.copyOfRange(nal.offset, nal.offset + nal.length)
      else if (PocketVideoAnnexB.isVcl(nal.type, codec) && PocketVideoAnnexB.isRandomAccess(nal.type, codec)) key = true
    }
    return Classified(key, sets, sets.isNotEmpty())
  }

  /** Bonjour type as NSD reports it ("_pocket-mon._tcp.") → "_pocket-mon._tcp". */
  fun normalizeType(type: String): String = type.trim().trimEnd('.').removeSuffix(".local")
}

/** `WatcherRelayFrameFreshness`: growth in delivery delay without synchronized clocks. */
internal class RelayFreshness {
  private var minimumOffset: Double? = null
  fun isFallingBehind(encodedAt: Double?, receivedAt: Double): Boolean {
    if (encodedAt == null || !encodedAt.isFinite()) return false
    val offset = receivedAt - encodedAt
    val min = minOf(minimumOffset ?: offset, offset)
    minimumOffset = min
    return offset - min > 0.75
  }
}
