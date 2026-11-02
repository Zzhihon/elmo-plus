import { BlockList, isIP } from "node:net";

const BLOCKED_V4: Array<[string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

const BLOCKED_V6: Array<[string, number]> = [
	["::", 128],
	["::1", 128],
	["100::", 64],
	["2001::", 23],
	["2001:db8::", 32],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
];

const blockList = new BlockList();
for (const [network, prefix] of BLOCKED_V4) blockList.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of BLOCKED_V6) blockList.addSubnet(network, prefix, "ipv6");

function expandV6(address: string): number[] | null {
	let input = address.toLowerCase();
	const zone = input.indexOf("%");
	if (zone >= 0) input = input.slice(0, zone);
	let tail: number[] = [];
	const lastColon = input.lastIndexOf(":");
	const maybeV4 = input.slice(lastColon + 1);
	if (maybeV4.includes(".")) {
		if (isIP(maybeV4) !== 4) return null;
		const octets = maybeV4.split(".").map(Number);
		tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
		input = `${input.slice(0, lastColon + 1)}0:0`;
	}
	const [head, rest] = input.split("::");
	const parse = (part: string | undefined) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
	const left = parse(head);
	const right = parse(rest);
	const fill = input.includes("::") ? 8 - left.length - right.length : 0;
	const groups = [...left, ...new Array(Math.max(fill, 0)).fill(0), ...right];
	if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return null;
	if (tail.length) groups.splice(6, 2, ...tail);
	return groups;
}

function v4FromGroups(high: number, low: number): string {
	return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** The IPv4 address an IPv6 form carries (mapped, NAT64, 6to4), which is what the packet reaches. */
function embeddedV4(groups: number[]): string | null {
	const isZero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
	if (isZero(0, 5) && groups[5] === 0xffff) return v4FromGroups(groups[6], groups[7]);
	if (isZero(0, 6)) return v4FromGroups(groups[6], groups[7]);
	if (groups[0] === 0x64 && groups[1] === 0xff9b && isZero(2, 6)) return v4FromGroups(groups[6], groups[7]);
	if (groups[0] === 0x2002) return v4FromGroups(groups[1], groups[2]);
	return null;
}

/**
 * True only for an address on the public internet. Loopback, private, link-local
 * (which holds the cloud metadata endpoints), carrier-grade NAT, multicast,
 * documentation and reserved ranges are all refused, including when they hide
 * inside an IPv6 form.
 */
export function isPublicAddress(address: string): boolean {
	const family = isIP(address.split("%")[0]);
	if (family === 4) return !blockList.check(address, "ipv4");
	if (family !== 6) return false;
	const groups = expandV6(address);
	if (!groups) return false;
	const v4 = embeddedV4(groups);
	if (v4 !== null) return isPublicAddress(v4);
	const canonical = groups.map((group) => group.toString(16)).join(":");
	return !blockList.check(canonical, "ipv6");
}
