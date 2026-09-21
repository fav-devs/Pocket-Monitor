import COpcDesktop
import Foundation
import OpenPocketViewCore

// ---- Station Wi-Fi: the camera joins a network instead of hosting one --------
//
// Frames and reply readings come from `MulticamCommands`, `MulticamJoinPolicy` and
// `MulticamStationPolicy`, observed on hardware. The desktop shell sequences them over
// Bluetooth and decides nothing about the bytes.

/// `0x07/0x39`: which Wi-Fi role the camera is in. Replies `00 01` station, `00 00`
/// access point, `e0` when the body has no such getter.
@_cdecl("opc_station_wifi_work_mode")
func opc_station_wifi_work_mode(
    _ seq: UInt16, _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int
) -> Int64 {
    DesktopFacade.emit(
        Data(Duml.encode(MulticamCommands.wifiWorkMode(seq: seq))), into: out, capacity: capacity)
}

/// `0x07/0x48`: station role on (1) or back to its own access point (0).
@_cdecl("opc_station_mode")
func opc_station_mode(
    _ enabled: Int32, _ seq: UInt16, _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int
) -> Int64 {
    DesktopFacade.emit(
        Data(Duml.encode(MulticamCommands.stationMode(enabled != 0, seq: seq))),
        into: out, capacity: capacity)
}

/// `0x07/0x47`: join this network. Rejects an empty or over-long name or password.
@_cdecl("opc_station_join")
func opc_station_join(
    _ ssid: UnsafePointer<CChar>?, _ password: UnsafePointer<CChar>?, _ seq: UInt16,
    _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int
) -> Int64 {
    guard let ssid, let password else { return Int64(OPC_RELAY_ERR_NULL) }
    guard
        let frame = try? MulticamCommands.join(
            ssid: String(cString: ssid), password: String(cString: password), seq: seq)
    else { return Int64(OPC_RELAY_ERR_OUT_OF_RANGE) }
    return DesktopFacade.emit(Data(Duml.encode(frame)), into: out, capacity: capacity)
}

/// `0x08/0x02/0xe1 01`: the video shooting mode the Pocket 4 Pro wants selected before
/// it joins a network.
@_cdecl("opc_station_video_mode")
func opc_station_video_mode(
    _ seq: UInt16, _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int
) -> Int64 {
    DesktopFacade.emit(
        Data(Duml.encode(MulticamCommands.videoMode(seq: seq))), into: out, capacity: capacity)
}

/// What a `0x07/0x39` reply means: 0 already station, 1 access point (set, then verify),
/// 2 no getter on this body (set without readback), 3 not a supported reply.
@_cdecl("opc_station_role_decision")
func opc_station_role_decision(
    _ reply: UnsafePointer<UInt8>?, _ count: Int, _ allowMissingQuery: Int32
) -> Int32 {
    guard let reply, count >= 0 else { return 3 }
    switch MulticamStationPolicy.decision(
        reply: Array(DesktopFacade.borrow(reply, count)), allowMissingQuery: allowMissingQuery != 0)
    {
    case .alreadyStation: return 0
    case .setAndVerify: return 1
    case .setWithoutReadback: return 2
    case .reject: return 3
    }
}

/// Whether a `0x07/0x48` reply accepted the role change.
@_cdecl("opc_station_setter_accepts")
func opc_station_setter_accepts(
    _ reply: UnsafePointer<UInt8>?, _ count: Int, _ missingQuery: Int32
) -> Int32 {
    guard let reply, count >= 0 else { return 0 }
    return MulticamStationPolicy.acceptsSetter(
        Array(DesktopFacade.borrow(reply, count)), missingQuery: missingQuery != 0) ? 1 : 0
}

/// What a `0x07/0x47` reply means on attempt `attempt`: 0 joined, 1 try again, 2 refused.
@_cdecl("opc_station_join_decision")
func opc_station_join_decision(
    _ reply: UnsafePointer<UInt8>?, _ count: Int, _ attempt: Int32
) -> Int32 {
    guard let reply, count >= 0 else { return 2 }
    switch MulticamJoinPolicy.decision(
        reply: Array(DesktopFacade.borrow(reply, count)), attempt: Int(attempt))
    {
    case .connected: return 0
    case .retry: return 1
    case .rejected: return 2
    }
}

/// The join's bounded retry: attempts, the settle before the first join, the reply
/// wait, and the pause between attempts, in seconds.
@_cdecl("opc_station_join_policy")
func opc_station_join_policy(
    _ attempts: UnsafeMutablePointer<Int32>?, _ settle: UnsafeMutablePointer<Int32>?,
    _ replyTimeout: UnsafeMutablePointer<Double>?, _ retryDelay: UnsafeMutablePointer<Int32>?
) {
    attempts?.pointee = Int32(MulticamJoinPolicy.maximumAttempts)
    settle?.pointee = Int32(MulticamJoinPolicy.prepareSettleSeconds)
    replyTimeout?.pointee = MulticamJoinPolicy.replyTimeoutSeconds
    retryDelay?.pointee = Int32(MulticamJoinPolicy.retryDelaySeconds)
}
