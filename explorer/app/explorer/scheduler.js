// Explorer-owned scheduling, recording and replay for holds at real async waits.
// The waits are the provider calls the settlement orchestrator
// already awaits (reserve, commit, release, status, refund). app/core never
// imports this. It delays those calls; arguments, results and errors pass through unchanged, and
// nothing here writes to the core trace.

export const PHASES = ['response', 'request', 'off'];
const IO = ['reserve', 'commit', 'release', 'status', 'refund'];
const COORD_ASYNC = ['submit', 'resubmit', 'reconcile', 'recover', 'refund', 'dispute'];
const COORD_SYNC = ['approve', 'cancel', 'changeOffer', 'reviseInstruction', 'reprice'];
const OP_NAME = { submit: 'Submission', resubmit: 'Resubmission', reconcile: 'Status check', recover: 'Recovery', refund: 'Refund', dispute: 'Dispute' };
const WHAT = { reserve: 'reserve', commit: 'commit', release: 'release', status: 'status query', refund: 'return' };

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const keyOf = (method, args) => {
  const a = args[0];
  if (method === 'reserve') return a ? `${a.purchaseId}:v${a.proposalVersion}:${a.role}` : '';
  return String(a);
};

// One scheduler per world. run() starts an explorer action and resolves at its
// first settle point: a hold it reached, or completion. release() continues one
// held call and resolves at that action's next settle point. Only one action
// runs at a time, so whatever executes between settle points belongs to it.
export function createScheduler(w, opts = {}) {
  let phase = PHASES.includes(opts.phase) ? opts.phase : 'response';
  const bypass = !!opts.bypass;
  let disposed = false; let current = null; let depth = 0; let opSeq = 0; let holdSeq = 0;
  const ops = new Map(); const waits = new Map(); const occ = new Map();

  const settle = (op, value) => { const s = op.settle; op.settle = null; if (current === op.id) current = null; if (s) s.resolve({ opId: op.id, ...value }); };
  const call = (orig, args) => { depth += 1; try { return orig(...args); } finally { depth -= 1; } };
  const outcome = async (orig, args) => {
    let p;
    try { p = call(orig, args); } catch (error) { return { failed: true, error }; }
    try { return { failed: false, result: await p }; } catch (error) { return { failed: true, error }; }
  };
  const hold = (op, info, ph, out) => {
    const base = `a${op.n}:${info.coord}:${info.route}.${info.method}:${info.key}`;
    const k = (occ.get(base) || 0) + 1; occ.set(base, k);
    const gate = deferred();
    const wt = { id: `${base}#${k}@${ph}`, opId: op.id, n: op.n, ctx: op.ctx, ...info, phase: ph, delivered: out ? (out.failed ? 'error' : 'result') : null, reply: out ? (out.failed ? { error: String((out.error && out.error.message) || out.error) } : out.result) : null, seq: ++holdSeq, gate };
    waits.set(wt.id, wt);
    settle(op, { held: wt });
    return gate.promise;
  };
  const wrapIO = (obj, method, route) => {
    if (!obj || typeof obj[method] !== 'function') return;
    const orig = obj[method].bind(obj);
    obj[method] = (...args) => {
      const op = current != null ? ops.get(current) : null;
      if (bypass || disposed || depth > 0 || phase === 'off' || !op) return call(orig, args);
      const ph = phase;
      const info = { route, method, coord: op.coord ? op.coord.name : method, purchaseId: op.coord ? op.coord.purchaseId : null, key: keyOf(method, args), args };
      return (async () => {
        let out;
        if (ph === 'request') { await hold(op, info, ph, null); out = await outcome(orig, args); }
        else { out = await outcome(orig, args); await hold(op, info, ph, out); }
        if (out.failed) throw out.error;
        return out.result;
      })();
    };
  };
  for (const pr of new Set(w.providers ? w.providers.values() : [])) for (const m of IO) wrapIO(pr, m, pr.provider);
  // Observation only: which coordinator operation a wait belongs to, for labels and anchors.
  const C = w.coordinator;
  for (const name of COORD_ASYNC) {
    if (typeof C[name] !== 'function') continue;
    const orig = C[name].bind(C);
    C[name] = (p, ...rest) => {
      const op = current != null ? ops.get(current) : null;
      if (!op) return orig(p, ...rest);
      const prev = op.coord; op.coord = { name, purchaseId: typeof p === 'string' ? p : p && p.purchaseId };
      let r;
      try { r = orig(p, ...rest); } catch (e) { op.coord = prev; throw e; }
      const restore = () => { if (op.coord && op.coord.name === name) op.coord = prev; };
      Promise.resolve(r).then(restore, restore);
      return r;
    };
  }

  return {
    get phase() { return phase; },
    setPhase(ph) { if (PHASES.includes(ph)) phase = ph; },
    get current() { return current; },
    get ctx() { const op = current != null ? ops.get(current) : null; return op ? op.ctx : null; },
    run(fn, ctx) {
      if (disposed) return Promise.resolve({ abandoned: true });
      const op = { id: ++opSeq, n: opSeq, ctx, coord: null, settle: deferred(), done: false };
      ops.set(op.id, op); if (ctx) ctx.opId = op.id;
      const first = op.settle.promise;
      current = op.id;
      let p; try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
      p.then((value) => { op.done = true; if (!disposed) settle(op, { done: true, value }); }, (error) => { op.done = true; if (!disposed) settle(op, { done: true, error }); });
      return first;
    },
    release(id) {
      const wt = waits.get(id); if (!wt || disposed) return null;
      const op = ops.get(wt.opId); waits.delete(id);
      op.settle = deferred(); const next = op.settle.promise;
      current = op.id; wt.gate.resolve();
      return next;
    },
    find(id) { return waits.get(id) || null; },
    outstanding() { return [...waits.values()].sort((a, b) => a.seq - b.seq); },
    busy() { return [...ops.values()].some((o) => !o.done); },
    // Abandon this world: pending settles resolve as abandoned and held gates
    // never open, so code from the old run can never touch the new one.
    dispose() {
      if (disposed) return; disposed = true; current = null;
      for (const op of ops.values()) if (op.settle) { const s = op.settle; op.settle = null; s.resolve({ opId: op.id, abandoned: true }); }
      waits.clear();
    },
  };
}

// The agreed core contract, applied at the explorer boundary only while the
// generated app/core predates it (see probeNativeGuard). While submit,
// resubmit, reconcile, recover or refund runs, every competing mutation of the
// same purchase is refused with operation_in_progress. Other purchases are
// untouched; signatures and purchase states are unchanged.
export function installContractGuard(C) {
  const running = new Set();
  const refusal = () => new Error('operation_in_progress');
  for (const name of COORD_ASYNC) {
    if (typeof C[name] !== 'function') continue;
    const orig = C[name].bind(C);
    C[name] = (p, ...rest) => {
      if (running.has(p)) return Promise.reject(refusal());
      running.add(p);
      let r;
      try { r = orig(p, ...rest); } catch (e) { running.delete(p); throw e; }
      const done = () => running.delete(p);
      Promise.resolve(r).then(done, done);
      return r;
    };
  }
  for (const name of COORD_SYNC) {
    if (typeof C[name] !== 'function') continue;
    const orig = C[name].bind(C);
    C[name] = (p, ...rest) => { if (running.has(p)) throw refusal(); return orig(p, ...rest); };
  }
}

// Does this app/core already refuse a competing cancel during submission?
export async function probeNativeGuard(sc) {
  const w = sc.world();
  const p = sc.lunch(w);
  sc.approveAs(w, p, sc.EMPLOYEE);
  if (p.state !== 'ready') return false;
  const pr = w.providers.get(sc.EMPLOYEE); const orig = pr.reserve.bind(pr); const gate = deferred();
  pr.reserve = async (...a) => { await gate.promise; return orig(...a); };
  // Signed-caller cores (2026.11-2+) take purchaseIds and signed requests.
  const signed = typeof sc.submitAs === 'function';
  const run = (signed ? sc.submitAs(w, p, sc.EMPLOYEE) : w.coordinator.submit(p, 'atomic')).catch(() => {});
  let native = false;
  try { if (signed) sc.cancelAs(w, p, sc.EMPLOYEE); else w.coordinator.cancel(p); } catch (e) { native = /operation_in_progress/.test(String(e && e.message)); }
  gate.resolve(); await run;
  return native;
}

export function waitText(wt) {
  const name = OP_NAME[wt.coord] || 'Operation';
  const via = wt.route;
  const what = WHAT[wt.method] || wt.method;
  return {
    name, via, what,
    title: wt.phase === 'response' ? `${name} running — waiting for ${via}’s ${what} reply` : `${name} running — ${what} not sent to ${via} yet`,
    action: wt.phase === 'response' ? 'Provider reply' : 'Send request',
    sub: [wt.purchaseId, `${wt.route}.${wt.method}()`, wt.key].filter(Boolean).join(' · '),
  };
}

// ---------- experiment log ----------
// Entries: { t: 'act', step, anchors, sel } · { t: 'release', wait } · { t: 'phase', phase }.
// Anchors and waits are wait ids (action, operation, route, method, key,
// occurrence, phase) — never displayed step numbers.
const sameArgs = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});
export function sameEntry(a, b) {
  if (!a || !b || a.t !== b.t) return false;
  if (a.t === 'act') return a.step.op === b.step.op && sameArgs(a.step.args, b.step.args) && (a.sel ?? null) === (b.sel ?? null) && (a.anchors || []).join('|') === (b.anchors || []).join('|');
  if (a.t === 'release') return a.wait === b.wait;
  return a.phase === b.phase;
}

// May this entry be replayed against the waits now outstanding? Never moves an
// action to a different wait: a mismatch stops replay with the reason.
export function checkEntry(e, outstanding) {
  const have = outstanding.map((x) => x.id);
  if (e.t === 'release') {
    return have.includes(e.wait) ? { ok: true } : { ok: false, reason: `Replay stopped: the recorded wait ${e.wait} never occurred in the rebuilt run, so its release was not applied anywhere else.` };
  }
  if (e.t === 'act') {
    const want = e.anchors || [];
    const miss = want.filter((k) => !have.includes(k)); const extra = have.filter((k) => !want.includes(k));
    if (miss.length) return { ok: false, reason: `Replay stopped before “${e.step.label}”: it was anchored to ${miss.join(', ')}, which the rebuilt run never reached. It was not moved elsewhere.` };
    if (extra.length) return { ok: false, reason: `Replay stopped before “${e.step.label}”: the rebuilt run is waiting at ${extra.join(', ')}, which was not held when you first ran it.` };
  }
  return { ok: true };
}
