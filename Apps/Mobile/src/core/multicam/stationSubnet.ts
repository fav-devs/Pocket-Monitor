/**
 * The phone's IPv4 subnet on a station network, as a bounded list of hosts to look for cameras on.
 * Source of truth: OpenCine `OpenCineCore/StationSubnet.swift` (`MulticamDiscovery.hosts`).
 *
 * `candidateHosts` is new here: the native module reports the phone's address but not its
 * netmask, so the mask is inferred (an iPhone Personal Hotspot is 172.20.10.0/28; other networks
 * are treated as /24, the home-router default).
 */

/** A dotted IPv4 string as a 32-bit unsigned value, or null when malformed. */
export function parseIPv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!part || part.length > 3 || !/^[0-9]+$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    out = out * 256 + byte;
  }
  return out >>> 0;
}

const format = (v: number) => [24, 16, 8, 0].map((s) => String((v >>> s) & 255)).join('.');

export const StationSubnet = {
  /**
   * Every unicast host of `address`'s subnet except `address` and `excluding`, in address order;
   * null for a malformed address or mask, a non-contiguous mask, or a subnet with more than 1,022
   * hosts or fewer than two.
   */
  hosts(address: string, mask: string, excluding: Iterable<string> = []): string[] | null {
    const ip = parseIPv4(address);
    const netmask = parseIPv4(mask);
    if (ip == null || netmask == null) return null;
    const hostBits = ~netmask >>> 0;
    if (!(hostBits > 1 && hostBits <= 1023 && (hostBits & (hostBits + 1)) === 0)) return null;
    const network = (ip & netmask) >>> 0;
    const skip = new Set(excluding);
    const out: string[] = [];
    for (let offset = 1; offset < hostBits; offset++) {
      const value = (network | offset) >>> 0;
      const host = format(value);
      if (value !== ip && !skip.has(host)) out.push(host);
    }
    return out;
  },

  /** A dotted IPv4 unicast address a camera can hold: not 0.x, loopback or multicast and above. */
  validAddress(value: string): boolean {
    const a = parseIPv4(value);
    if (a == null) return false;
    const first = a >>> 24;
    return first > 0 && first < 224 && first !== 127;
  },
};

/** iPhone Personal Hotspot: the phone is 172.20.10.1, clients 172.20.10.2–14. */
export const IOS_HOTSPOT = { address: '172.20.10.1', mask: '255.255.255.240' } as const;

/**
 * Hosts to probe for a camera on the shared network, given this phone's address there (null when
 * unknown). A hotspot without a known address falls back to the iPhone hotspot subnet.
 */
export function candidateHosts(ctx: { localAddress: string | null; hotspot: boolean; excluding?: Iterable<string> }): string[] {
  const local = ctx.localAddress && StationSubnet.validAddress(ctx.localAddress) ? ctx.localAddress : null;
  let address: string;
  let mask: string;
  if (local && local.startsWith('172.20.10.')) {
    address = local;
    mask = IOS_HOTSPOT.mask;
  } else if (local) {
    address = local;
    mask = '255.255.255.0';
  } else if (ctx.hotspot) {
    address = IOS_HOTSPOT.address;
    mask = IOS_HOTSPOT.mask;
  } else {
    return [];
  }
  return StationSubnet.hosts(address, mask, ctx.excluding) ?? [];
}
