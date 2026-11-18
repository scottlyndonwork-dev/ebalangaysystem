import { BlockList, isIP } from 'node:net';

/**
 * Builds a matcher for IPs and CIDRs, e.g. ["203.0.113.7", "10.0.0.0/8", "2001:db8::/32"].
 * An empty list allows everything (env validation requires a list in production).
 */
export function createIpAllowlist(entries: readonly string[]): (ip: string) => boolean {
  if (entries.length === 0) return () => true;
  const list = new BlockList();
  for (const entry of entries) {
    const [addr, prefix] = entry.split('/');
    const family = isIP(addr ?? '');
    if (!addr || family === 0) throw new Error(`ADMIN_IP_ALLOWLIST: invalid entry "${entry}"`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(prefix), type);
  }
  return (ip) => {
    // IPv4 clients behind a dual-stack socket show up as ::ffff:1.2.3.4.
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
    const addr = v4 ?? ip;
    const family = isIP(addr);
    if (family === 0) return false;
    return list.check(addr, family === 6 ? 'ipv6' : 'ipv4');
  };
}
