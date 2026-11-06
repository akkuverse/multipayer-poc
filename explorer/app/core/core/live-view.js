// GENERATED from src/core/live-view.ts — type-stripped build artifact; never hand-edit.
// Live read-only views over coordinator purchase records. A view always
// reads the current record and throws on every write, so a caller can never
// mutate coordinator state. Records must be plain data — primitives, plain
// objects and arrays only. A Map, Set, Date or class instance is refused at
// wrap time: proxied its methods would fail later on an incompatible
// receiver, and that failure belongs at the view, not inside a caller.
// The proxy machinery is generic, but it is deployed for purchase records
// only — the error strings name that deployment on purpose.

// One proxy per reached target, shared by every view: nested identity is
// stable (v.legs === v.legs) and cyclic graphs wrap exactly once.
const proxies = new WeakMap();
// Every handed-out proxy mapped back to its target — unwrapView is the only
// way back across the seam, for the snapshot sites that detach a copy.
const targets = new WeakMap();

const isPlainData = (value) => {
  if (value === null || typeof value !== 'object') return typeof value !== 'function';
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === Array.prototype || proto === null;
};

// Assert every value reachable from root is plain data, once per record.
// The visited set keeps cyclic graphs from recursing forever; a purchase
// record never contains one.
const assertPlainData = (root) => {
  const visited = new Set();
  const walk = (value) => {
    if (!isPlainData(value)) throw new TypeError('purchase view only wraps plain data');
    if (value === null || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    for (const v of Object.values(value)) walk(v);
  };
  walk(root);
};

const handler = {
  // Functions pass through unwrapped so read methods still work on the proxy
  // receiver; mutating ones die in the write traps below.
  get: (target, prop) => {
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value : wrap(value);
  },
  getOwnPropertyDescriptor: (target, prop) => {
    const d = Reflect.getOwnPropertyDescriptor(target, prop);
    // A descriptor would hand the raw nested value straight past the seam.
    if (d && 'value' in d) d.value = wrap(d.value);
    return d;
  },
  set: () => {
    throw new TypeError('purchase view is read-only');
  },
  deleteProperty: () => {
    throw new TypeError('purchase view is read-only');
  },
  defineProperty: () => {
    throw new TypeError('purchase view is read-only');
  },
  setPrototypeOf: () => {
    throw new TypeError('purchase view is read-only');
  },
  // A trap is not enough on its own here: Object.preventExtensions(v)
  // would forward to the target, and Object.freeze(v) runs
  // [[PreventExtensions]] on the target before the defineProperty trap
  // throws — leaving the record non-extensible even though the call
  // failed, and bricking later fields such as receipt or dispute.
  preventExtensions: () => {
    throw new TypeError('purchase view is read-only');
  },
};

// Lazily proxied: values are wrapped as a get reaches them, so wrapping
// never descends a graph eagerly and cycles terminate through `proxies`.
const wrap = (value) => {
  if (value === null || typeof value !== 'object') return value;
  let proxy = proxies.get(value);
  if (proxy === undefined) {
    if (!isPlainData(value)) throw new TypeError('purchase view only wraps plain data');
    proxy = new Proxy(value, handler);
    proxies.set(value, proxy);
    targets.set(proxy, value);
  }
  return proxy ;
};

// The live read-only facet of a record: reads always reflect it, writes
// throw TypeError('purchase view is read-only'). Plain-data records only —
// checked eagerly so a non-plain field fails here, never mid-read.
export const readonlyView = (record) => {
  assertPlainData(record);
  return wrap(record);
};

// The record a view wraps, or the value itself when it was never proxied.
// Snapshot sites detach with structuredClone(unwrapView(view)); cloning the
// view itself throws DataCloneError — proxies are not cloneable.
export const unwrapView = (view) => (targets.get(view) ?? view) ;
