import Darwin
import Foundation

/// getifaddrs-based view of this phone's IPv4 addresses. The camera SoftAP is `192.168.2.1`; the
/// phone has a usable datalink path only once DHCP gives it `192.168.2.2…254`
/// (`CameraSoftAP.isAssociatedIPv4`).
enum OpcNetworkInterfaces {
  struct Address: Equatable {
    let name: String
    let ipv4: String
  }

  static func ipv4Addresses() -> [Address] {
    var out: [Address] = []
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return out }
    defer { freeifaddrs(head) }
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let ifa = cursor {
      defer { cursor = ifa.pointee.ifa_next }
      let flags = Int32(ifa.pointee.ifa_flags)
      guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0,
        let sa = ifa.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET)
      else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let rc = getnameinfo(
        sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
      guard rc == 0 else { continue }
      out.append(Address(name: String(cString: ifa.pointee.ifa_name), ipv4: String(cString: host)))
    }
    return out
  }

  /// Phone address on the camera AP. `.1` is the camera; `.0` / `.255` are not hosts.
  static func isCameraClientIPv4(_ ip: String) -> Bool {
    let parts = ip.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4, parts[0] == "192", parts[1] == "168", parts[2] == "2",
      let host = Int(parts[3]), (2...254).contains(host)
    else { return false }
    return true
  }

  /// First `192.168.2.2…254` address and its interface name (normally `en0`).
  static func cameraAddress() -> Address? {
    ipv4Addresses().first { isCameraClientIPv4($0.ipv4) }
  }

  /// The local IPv4 on the subnet `/24` of `host` (e.g. a station-mode camera), if any.
  static func address(sameSubnetAs host: String) -> Address? {
    let prefix = host.split(separator: ".").prefix(3).joined(separator: ".") + "."
    return ipv4Addresses().first { $0.ipv4.hasPrefix(prefix) && $0.ipv4 != host }
  }

  static var isSimulator: Bool {
    #if targetEnvironment(simulator)
      return true
    #else
      return false
    #endif
  }
}
