const TRUSTED_PROXY_CIDR = '127.0.0.1/32';

export function parseTrustedProxyAddresses(value) {
  if (value === undefined) return [TRUSTED_PROXY_CIDR];
  if (typeof value !== 'string') {
    throw new Error('TRUST_PROXY_ADDRESSES must be exactly 127.0.0.1/32.');
  }

  const addresses = value.split(',').map((address) => address.trim());
  if (addresses.length !== 1 || addresses[0] !== TRUSTED_PROXY_CIDR) {
    throw new Error('TRUST_PROXY_ADDRESSES must be exactly 127.0.0.1/32.');
  }
  return addresses;
}

export function parsePublicOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error('PUBLIC_ORIGIN must be a canonical HTTPS origin.');
  }

  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be a canonical HTTPS origin.');
  }

  if (origin.protocol !== 'https:' || origin.origin !== value) {
    throw new Error('PUBLIC_ORIGIN must be a canonical HTTPS origin.');
  }
  return origin.origin;
}

export function isAllowedPublicOrigin(value, publicOrigin) {
  if (typeof value !== 'string') return false;
  try {
    const origin = new URL(value);
    return value === origin.origin && origin.origin === publicOrigin;
  } catch {
    return false;
  }
}
