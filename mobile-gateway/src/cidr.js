'use strict';

const net = require('node:net');

function stripAddressDecorations(value) {
  let result = String(value || '').trim();
  if (result.startsWith('[') && result.includes(']')) result = result.slice(1, result.indexOf(']'));
  const zone = result.indexOf('%');
  if (zone !== -1) result = result.slice(0, zone);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(result)) result = result.slice(7);
  return result;
}

function parseIpv4(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${value}`);
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`Invalid IPv4 address: ${value}`);
    const octet = Number(part);
    if (octet < 0 || octet > 255) throw new Error(`Invalid IPv4 address: ${value}`);
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

function expandIpv6Parts(value) {
  const source = String(value).toLowerCase();
  if ((source.match(/::/g) || []).length > 1) throw new Error(`Invalid IPv6 address: ${value}`);
  const [leftRaw, rightRaw] = source.includes('::') ? source.split('::') : [source, null];
  const parseSide = raw => raw ? raw.split(':').filter(Boolean) : [];
  const left = parseSide(leftRaw);
  const right = rightRaw === null ? [] : parseSide(rightRaw);

  const convertIpv4Tail = parts => {
    if (!parts.length || !parts[parts.length - 1].includes('.')) return parts;
    const ipv4 = parseIpv4(parts[parts.length - 1]);
    return [
      ...parts.slice(0, -1),
      Number((ipv4 >> 16n) & 0xffffn).toString(16),
      Number(ipv4 & 0xffffn).toString(16),
    ];
  };

  const normalizedLeft = convertIpv4Tail(left);
  const normalizedRight = convertIpv4Tail(right);
  const used = normalizedLeft.length + normalizedRight.length;
  if (rightRaw === null && used !== 8) throw new Error(`Invalid IPv6 address: ${value}`);
  if (rightRaw !== null && used >= 8) throw new Error(`Invalid IPv6 address: ${value}`);
  const missing = rightRaw === null ? 0 : 8 - used;
  const parts = [...normalizedLeft, ...Array(missing).fill('0'), ...normalizedRight];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) {
    throw new Error(`Invalid IPv6 address: ${value}`);
  }
  return parts;
}

function parseIpv6(value) {
  let result = 0n;
  for (const part of expandIpv6Parts(value)) result = (result << 16n) | BigInt(`0x${part}`);
  return result;
}

function parseIp(value) {
  const address = stripAddressDecorations(value);
  const family = net.isIP(address);
  if (family === 4) return { address, bits: 32, value: parseIpv4(address) };
  if (family === 6) return { address, bits: 128, value: parseIpv6(address) };
  throw new Error(`Invalid IP address: ${value}`);
}

function parseCidr(value) {
  const source = String(value || '').trim();
  const [address, prefixRaw, ...extra] = source.split('/');
  if (!address || prefixRaw === undefined || extra.length) throw new Error(`Invalid CIDR: ${value}`);
  const parsed = parseIp(address);
  if (!/^\d+$/.test(prefixRaw)) throw new Error(`Invalid CIDR prefix: ${value}`);
  const prefix = Number(prefixRaw);
  if (prefix < 0 || prefix > parsed.bits) throw new Error(`Invalid CIDR prefix: ${value}`);
  const shift = BigInt(parsed.bits - prefix);
  const network = shift === 0n ? parsed.value : (parsed.value >> shift) << shift;
  return Object.freeze({ source, bits: parsed.bits, prefix, network });
}

function ipInCidr(address, cidr) {
  const parsedAddress = parseIp(address);
  const parsedCidr = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (parsedAddress.bits !== parsedCidr.bits) return false;
  const shift = BigInt(parsedAddress.bits - parsedCidr.prefix);
  const network = shift === 0n ? parsedAddress.value : (parsedAddress.value >> shift) << shift;
  return network === parsedCidr.network;
}

function ipInAnyCidr(address, cidrs) {
  return cidrs.some(cidr => ipInCidr(address, cidr));
}

module.exports = { stripAddressDecorations, parseIp, parseCidr, ipInCidr, ipInAnyCidr };

