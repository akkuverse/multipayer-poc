// Hand-written, committed (not emitted). Implements exactly the node:crypto
// surface src/ uses — createHash('sha256'), createPrivateKey (Ed25519 PKCS#8
// DER), createPublicKey, sign(null, …), verify(null, …) — plus the Buffer
// slice src/core/signing.ts relies on: from(hex | utf8 | base64url | bytes),
// concat, toString('base64url' | 'hex' | 'utf8'). All calls are synchronous,
// matching the coordinator's synchronous verifyPayload/signPayload call sites.
// Backed by audited pure-JS noble (vendored ESM, zero transitive deps).
import * as ed from '../vendor/noble/ed25519.js';
import { sha256 } from '../vendor/noble/hashes/sha256.js';
import { sha512 } from '../vendor/noble/hashes/sha512.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

const fromHex = (s) => {
  if (s.length % 2) throw new Error('hex string must have even length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const toB64url = (b) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export class Buffer extends Uint8Array {
  static from(value, encoding) {
    if (typeof value === 'string') {
      if (encoding === 'hex') return new Buffer(fromHex(value));
      if (encoding === 'base64url') return new Buffer(fromB64url(value));
      if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') return new Buffer(utf8.encode(value));
      throw new Error(`Buffer shim: unsupported encoding ${encoding}`);
    }
    return new Buffer(value);
  }
  static concat(list) {
    const out = new Buffer(list.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
  }
  toString(encoding) {
    if (encoding === 'base64url') return toB64url(this);
    if (encoding === 'hex') return toHex(this);
    if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') return utf8d.decode(this);
    throw new Error(`Buffer shim: unsupported encoding ${encoding}`);
  }
}
// signing.ts uses Buffer as a Node global; it evaluates after this module.
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;

const bytes = (v) => (typeof v === 'string' ? utf8.encode(v) : new Uint8Array(v));

// KeyObject modelled as a raw-bytes wrapper: 32-byte seed or public key.
export class KeyObject {
  constructor(type, raw) {
    this.type = type;
    this.asymmetricKeyType = 'ed25519';
    this.raw = raw;
  }
}

export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw new Error(`node-crypto shim: unsupported hash ${algorithm}`);
  const parts = [];
  const h = {
    update(data) { parts.push(bytes(data)); return h; },
    digest(encoding) {
      const out = Buffer.from(sha256(Buffer.concat(parts)));
      return encoding ? out.toString(encoding) : out;
    },
  };
  return h;
}

const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';

export function createPrivateKey(opts) {
  if (!opts || opts.format !== 'der' || opts.type !== 'pkcs8') throw new Error('node-crypto shim: only DER PKCS#8 Ed25519 keys');
  const der = new Uint8Array(opts.key);
  if (der.length !== 48 || toHex(der.subarray(0, 16)) !== PKCS8_ED25519_PREFIX) throw new Error('node-crypto shim: not an Ed25519 PKCS#8 key');
  return new KeyObject('private', der.slice(16));
}

export function createPublicKey(key) {
  if (key instanceof KeyObject && key.type === 'private') return new KeyObject('public', ed.getPublicKey(key.raw));
  if (key instanceof KeyObject && key.type === 'public') return key;
  throw new Error('node-crypto shim: createPublicKey needs a KeyObject');
}

export function sign(algorithm, data, key) {
  if (algorithm !== null && algorithm !== undefined) throw new Error('node-crypto shim: Ed25519 signs with algorithm null');
  if (!(key instanceof KeyObject) || key.type !== 'private') throw new Error('node-crypto shim: sign needs a private KeyObject');
  return Buffer.from(ed.sign(bytes(data), key.raw));
}

export function verify(algorithm, data, key, signature) {
  if (algorithm !== null && algorithm !== undefined) throw new Error('node-crypto shim: Ed25519 verifies with algorithm null');
  const pub = key.type === 'private' ? ed.getPublicKey(key.raw) : key.raw;
  try {
    return ed.verify(bytes(signature), bytes(data), pub);
  } catch {
    return false;
  }
}
