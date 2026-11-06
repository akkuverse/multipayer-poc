// GENERATED from src/presenter/session.ts — type-stripped build artifact; never hand-edit.
// One presenter session owns one purchase and one fixed employee instruction.
// It exposes exactly two restricted handles: an agent presenter (discovery,
// evaluation, offer selection and explanation, each gated by a signed
// session-scoped grant) and a trusted user flow (the same read/selection
// surface plus approval, submission, reconciliation and a detached snapshot
// for the run record). Everything either handle returns is a detached
// projection built at call time — the coordinator, the live purchase, keys,
// the raw trace and settlement controls stay inside this module.
//
// Amounts and eligibility always come from the coordinator: a fresh quote for
// evaluation, the retained proposal for explanation. Offer text is data,
// never instructions or authority. One trusted clock (coordinator.now) serves
// every observation; callers cannot pass a time.

                                                          
import { verifyPayload } from '../core/signing.js';
                                                              
                                                  
                                                                                                                                                                                                                                                                   
import { unwrapView } from '../core/live-view.js';
import { viewFor } from '../core/privacy.js';
                                                    

// What a grant delegates. Mapping: discover → 'discover', evaluate/explain →
// 'explain', selectOffer → 'propose'. A grant delegates information and
// proposal operations only — never approval, submission or reconciliation.
                                                                 
const CAPABILITIES = new Set        (['discover', 'propose', 'explain']);

// The signed, session-scoped delegation. The principal is the employee whose
// instruction this session carries; the signature must verify against the key
// registered to that principal.
                             
                   
                  
                      
                    
                     
                                  
                    
 

// A returned projection plus its evidence sequences. Agents receive only
// the safe observation reference; trusted callers also receive audit events.
// eventSeqs are observation references only: they grant no access to the raw
// audit records behind them.
                              
           
                      
 

// A catalog entry as trusted construction supplies it. There is no payeeId:
// merchant and payee are identical in this mock.
                               
                   
                     
                
                 
                    
                                                                              
                                                
                                                      
                 
                         
 

// The agent-visible offer: sourced catalog fields plus the trusted time of
// this observation.
                            
                   
                     
                
                 
                    
                                                
                 
                         
                      
 

// The only reasons a projection may carry. Raw mandate references, other
// payer ids, signatures, ledger usage, idempotency keys and provider error
// detail stay inside the audit trace.
                        
                         
                         
                      
                             
                   
                       

// A sourced offer plus the deterministic split and current employee
// assessment it would produce as a fresh purchase.
                            
                   
                    
                                                       
                       
                                                                  
                     
                          
                                                                       
                                                                          
                                                                
                     
                                              
                           
                          
                        
 

// One authorization the coordinator has on record for this purchase and its
// basis. Recorded is not the same as currently valid: evidence bound to an
// old proposal version or past its expiry stays visible but authorises
// nothing.
                                            
                                            
                  
                                   
                       
                     
                                                                          
                          
                          
                                
                          
 

// What the employee-side recipient sees of the session's purchase: the payer
// projection plus the selected offer, the proposal it is bound to, the
// observed assessment, recorded authorizations and safe reasons.
                                
                   
                   
                   
                          
                            
                                                                            
                                                                      
                      
                                              
                           
                          
                                              
                        
 

                                 
                  
                             
 

// The only handle a scripted assistant receives. It can read the catalog,
// price offers and change the proposal — it cannot approve, submit, retry,
// reconcile, recover, refund or revise the instruction.
                                 
                                                          
                                                  
                                                         
                                     
 

// The employee's published standing terms as they may see them: limits,
// merchant lists, expiry and the observed revision — never the mandate
// reference, the signature or the key that made it.
                                    
                  
                  
                         
                             
                             
                             
                     
                   
 

// The trusted handle: explicit scripted human actions. Never offered as an
// agent tool.
                                    
                                                          
                                                  
                                                         
                                     
                                                                          
                                                                           
                                                                           
                               
                                                                                                    
                                                                     
                                                                        
                                                                       
                                                                            
                                                                         
                                                                          
                                    
                                                                          
                                                
                                                                         
                                                      
                                                   
                                                                            
                                                                         
                                               
                                               
                                                                           
                                                                          
                                                                            
                                     
                                                                 
                                                                           
                                                                        
                            
                                              
                                                                           
                                  
                       
 

// The deterministic no-tap executor, owned by the trusted side of the
// session. One step advances only the session's own purchase: it refreshes
// the open assessment under current standing terms, submits only when valid
// standing-mandate evidence funds the employee shares, and resolves a
// pending purchase through its frozen submission intent. It never approves,
// never creates a purchase and never starts a manual payment.
                                  
                                           
 

                                   
                        
                              
                          
 

                                          
                    
                     
                  
                                                                            
                                                
                     
                                                   
                           
                     
                            
                                   
                           
               
                    
                                                                           
                                                                           
                                                                          
                                             
                              
                                  
                                                                       
                                                                           
                                                                        
                                                                        
                                                                         
                                                                          
                                                                     
                                                                      
                                                                   
                                                                    
                                                                              
                                                                         
                                                                         
                 
                                                                                      
                                                                           
                                                                           
                                                                         
                                                                             
                                                                            
                                                                                                 
 

// States in which the offer may still change (the coordinator's OPEN set).
const SELECTABLE                  = ['draft', 'awaiting_approvals', 'ready'];

const GRANT_FIELDS = new Set(['grantRef', 'agentId', 'principalId', 'sessionId', 'purchaseId', 'capabilities', 'expiresAt']);
const PREF_FIELDS = new Set(['tags', 'maxWalkingMinutes']);

const isNonEmptyString = (v         )              => typeof v === 'string' && v.length > 0;
const isFiniteNumber = (v         )              => typeof v === 'number' && Number.isFinite(v);

// Internal policy/coordinator reasons that map to a distinct safe reason.
// Everything else collapses to 'benefit_unavailable' rather than leaking
// mandate, registry or ledger detail.
const SAFE_REASON                             = {
  merchant_not_eligible: 'merchant_ineligible',
};

const safeReason = (internal                    )                         => {
  if (internal === undefined) return undefined;
  return SAFE_REASON[internal] ?? 'benefit_unavailable';
};

// Runtime validation of one catalog entry, returning a detached copy. Invalid
// fixtures are construction errors: they throw, loudly, before any run.
const checkOffer = (raw         , seen             )               => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('catalog offers must be objects');
  }
  const o = raw                ;
  if (!isNonEmptyString(o.offerRef)) throw new Error('catalog offers need a non-empty offerRef');
  if (seen.has(o.offerRef)) throw new Error(`duplicate offerRef ${o.offerRef}`);
  seen.add(o.offerRef);
  if (!isNonEmptyString(o.merchantId)) throw new Error(`offer ${o.offerRef} needs a merchantId`);
  if (typeof o.title !== 'string') throw new Error(`offer ${o.offerRef} needs a title`);
  if (!Array.isArray(o.tags) || o.tags.some((t) => !isNonEmptyString(t))) {
    throw new Error(`offer ${o.offerRef} tags must be non-empty strings`);
  }
  if (!Number.isInteger(o.priceCents) || o.priceCents <= 0) {
    throw new Error(`offer ${o.offerRef} price must be positive integer cents`);
  }
  const a = o.availability;
  if (a === null || typeof a !== 'object' || !isFiniteNumber(a.from) || !isFiniteNumber(a.until) || a.from > a.until) {
    throw new Error(`offer ${o.offerRef} needs an ordered finite availability window`);
  }
  if (typeof o.source !== 'string') throw new Error(`offer ${o.offerRef} needs a source`);
  if (!isFiniteNumber(o.walkingMinutes) || o.walkingMinutes < 0) {
    throw new Error(`offer ${o.offerRef} needs a finite non-negative walking time`);
  }
  return structuredClone(o);
};

export function createPresenterSession(opts                         )                   {
  // Trusted construction inputs are validated and copied, so later mutation
  // of the caller's objects cannot rewrite the instruction, the catalog or
  // the grant.
  if (!isNonEmptyString(opts.sessionId)) throw new Error('session needs a sessionId');
  if (!isNonEmptyString(opts.purchaseId)) throw new Error('session needs a purchaseId');
  if (!isNonEmptyString(opts.agentId)) throw new Error('session needs an agentId');
  if (!isNonEmptyString(opts.employeeId)) throw new Error('session needs an employeeId');
  const employeeFeeCents = opts.employeeFeeCents ?? 0;
  if (!Number.isInteger(employeeFeeCents) || employeeFeeCents < 0) {
    throw new Error('employeeFeeCents must be non-negative integer cents');
  }
  if (!isNonEmptyString(opts.mandateRef)) throw new Error('session needs a mandateRef');
  if (!opts.coordinator) throw new Error('session needs a coordinator');
  if (!opts.trace) throw new Error('session needs a trace');
  if (!opts.keys) throw new Error('session needs a key registry');
  const submitPolicy = opts.submitPolicy ?? 'on_request';
  const settlementMode = opts.settlementMode ?? 'atomic';
  if (submitPolicy !== 'on_request' && submitPolicy !== 'on_ready') throw new Error('session needs a known submitPolicy');
  if (settlementMode !== 'atomic' && settlementMode !== 'independent') throw new Error('session needs a known settlementMode');
  if (typeof opts.signAsPrincipal !== 'function') throw new Error('session needs a signAsPrincipal callback');
  if (opts.signAsAgent !== undefined && typeof opts.signAsAgent !== 'function') {
    throw new Error('signAsAgent must be a function when given');
  }
  const signAsPrincipal = opts.signAsPrincipal;
  const signAsAgent = opts.signAsAgent;
  if (typeof opts.approveOnDevice !== 'function') throw new Error('session needs an approveOnDevice callback');
  if (typeof opts.updateEmployeeMandateOnDevice !== 'function') {
    throw new Error('session needs an updateEmployeeMandateOnDevice callback');
  }
  if (!Array.isArray(opts.catalog) || opts.catalog.length === 0) throw new Error('session needs a non-empty catalog');

  const sessionId = opts.sessionId;
  const purchaseId = opts.purchaseId;
  const agentId = opts.agentId;
  const employeeId = opts.employeeId;
  const mandateRef = opts.mandateRef;
  const coordinator = opts.coordinator;
  const trace = opts.trace;
  const keys = opts.keys;
  const approveOnDevice = opts.approveOnDevice;
  const updateEmployeeMandateOnDevice = opts.updateEmployeeMandateOnDevice;
  const seenRefs = new Set        ();
  const catalog                 = opts.catalog.map((o) => checkOffer(o, seenRefs));
  // A malformed grant must not break construction — the trusted handle still
  // works — but it must also never authorise. Copy defensively; every agent
  // operation re-validates it.
  const grant                                 = (() => {
    try {
      return structuredClone(opts.grant);
    } catch {
      return undefined;
    }
  })();

  // Retained state: whether this session's one purchase exists yet — it
  // lives inside the coordinator and is read through view() — plus the
  // offer bound to its current proposal, the async in-flight guard and the
  // action counter.
  let created = false;
  let selectedOfferRef                    ;
  let inFlight = false;
  let actions = 0;

  const now = ()         => coordinator.now;

  // Inclusive validity, matching coordinator approval expiry.
  const offerLive = (o              )          => o.availability.from <= now() && now() <= o.availability.until;

  // The refusal for a non-live offer. A window that has not opened yet is
  // not 'expired': these are internal error strings, so unlike the
  // recipient-safe reason allowlist they may be exact.
  const offerWindowError = (o              )        =>
    new Error(now() < o.availability.from ? 'offer_not_yet_available' : 'offer_expired');

  const offerView = (o              )            => ({
    offerRef: o.offerRef,
    merchantId: o.merchantId,
    title: o.title,
    tags: [...o.tags],
    priceCents: o.priceCents,
    availability: { ...o.availability },
    source: o.source,
    walkingMinutes: o.walkingMinutes,
    retrievedAt: now(),
  });

  const offerByRef = (raw         )               => {
    if (!isNonEmptyString(raw)) throw new Error('offer reference must be a non-empty string');
    const o = catalog.find((x) => x.offerRef === raw);
    if (!o) throw new Error('unknown_offer');
    return o;
  };

  const selectedOffer = ()                           =>
    selectedOfferRef === undefined ? undefined : catalog.find((o) => o.offerRef === selectedOfferRef);

  const requirePurchase = ()               => {
    if (!created) throw new Error('no_proposal');
    return coordinator.view(purchaseId);
  };

  const checkFree = (op        , channel                  )       => {
    if (inFlight) refuse(op, channel, new Error('operation_in_progress'));
  };

  // Every session event carries the session, purchase, action id, proposal
  // version where one exists and the trusted observation time. Agent events
  // additionally carry onBehalfOf and grantRef.
  const logEvent = (op        , channel                  , detail                         )       => {
    trace.add('LOCAL', 'presenter', `presenter_${op}`, {
      actionId: `${sessionId}:action-${++actions}`,
      channel,
      sessionId,
      purchaseId,
      proposalVersion: created ? coordinator.view(purchaseId).proposal.version : undefined,
      observedAt: now(),
      ...(channel === 'agent' ? { onBehalfOf: agentId, grantRef: grantRefOf() } : {}),
      ...detail,
    });
  };

  const grantRefOf = ()                     => {
    if (grant === null || typeof grant !== 'object') return undefined;
    const p          = (grant                      ).payload;
    if (p === null || typeof p !== 'object') return undefined;
    const ref = (p              ).grantRef;
    return isNonEmptyString(ref) ? ref : undefined;
  };

  // A grant denial: generic externally, specific in the audit event. Denials
  // without a usable grant record that absence. Appending evidence is the
  // only effect a denial may have — it cannot touch purchase, approvals,
  // ledger or settlement.
  const deny = (op        , reason        )        => {
    const ref = grantRefOf();
    logEvent('denied', 'agent', {
      op,
      reason,
      grantRef: ref,
      grantAbsent: ref === undefined,
    });
    throw new Error('presenter access denied');
  };

  // A refused operation still appends an audit event: the session fields
  // every event carries plus the op and the internal refusal reason — never
  // the generic denial text. Grant denials are logged by deny() before run()
  // is entered, so they cannot be logged twice through this path.
  const refuse = (op        , channel                  , err         )        => {
    logEvent('refused', channel, { op, reason: err instanceof Error ? err.message : String(err) });
    throw err;
  };

  // Full grant verification, run before the agent operation reads offers or
  // touches the coordinator. Signature first, expiry at the trusted clock,
  // then agent/principal/session/purchase binding and the capability.
  const grantProblem = (required                 )                     => {
    if (grant === null || typeof grant !== 'object') return 'malformed_grant';
    const s = grant                      ;
    const g          = s.payload;
    if (!isNonEmptyString(s.keyId) || !isNonEmptyString(s.signature)) return 'malformed_grant';
    if (g === null || typeof g !== 'object' || Array.isArray(g)) return 'malformed_grant';
    const p = g              ;
    // Unsupported signed fields are rejected, not ignored.
    for (const k of Object.keys(g)) if (!GRANT_FIELDS.has(k)) return 'malformed_grant';
    if (
      !isNonEmptyString(p.grantRef) ||
      !isNonEmptyString(p.agentId) ||
      !isNonEmptyString(p.principalId) ||
      !isNonEmptyString(p.sessionId) ||
      !isNonEmptyString(p.purchaseId)
    ) {
      return 'malformed_grant';
    }
    if (
      !Array.isArray(p.capabilities) ||
      p.capabilities.length === 0 ||
      p.capabilities.some((c) => !CAPABILITIES.has(c))
    ) {
      return 'malformed_grant';
    }
    if (!isFiniteNumber(p.expiresAt)) return 'malformed_grant';
    // The signature must verify against the principal the payload names; only
    // then can that field be compared to the session's trusted employee.
    if (!verifyPayload(s, keys, p.principalId)) return 'signature_invalid';
    if (now() > p.expiresAt) return 'grant_expired';
    if (p.agentId !== agentId) return 'wrong_agent';
    if (p.principalId !== employeeId) return 'wrong_principal';
    if (p.sessionId !== sessionId) return 'wrong_session';
    if (p.purchaseId !== purchaseId) return 'wrong_purchase';
    if (!p.capabilities.includes(required)) return 'missing_capability';
    return undefined;
  };

  const evidenceSince =    (first        , value   )              => {
    // Sequences appended while an async op is in flight may include events
    // other operations produced; sequential use attributes them exactly.
    const eventSeqs           = [];
    for (let seq = first + 1; seq <= trace.events.length; seq++) eventSeqs.push(seq);
    // Detached: a caller mutating the view can never rewrite the catalog, the
    // purchase or the retained evidence.
    return { value: structuredClone(value), eventSeqs };
  };

  const run =    (op        , channel                  , fn                                                      )              => {
    const first = trace.events.length;
    try {
      const r = fn();
      // Persist the observation before any conversation can claim it as
      // evidence. Snapshot is a trusted raw purchase export, never a safe
      // projection to copy into a presenter observation.
      logEvent(op, channel, {
        ...r.detail,
        ...(op === 'snapshot' ? {} : { observation: structuredClone(r.value) }),
      });
      // The agent's evidence is the seq of the observation event just
      // appended — it sees its own observation, not the internal events the
      // operation produced. The trusted channel cites all of them.
      return evidenceSince(channel === 'agent' ? trace.events.length - 1 : first, r.value);
    } catch (err) {
      refuse(op, channel, err);
    }
  };

  // Async twin of run() for submit and reconcile — operations only the
  // trusted flow has, so the agent channel's narrow evidence window never
  // applies here.
  const runAsync = async    (
    op        ,
    channel                  ,
    fn                                                               ,
  )                       => {
    const first = trace.events.length;
    try {
      const r = await fn();
      logEvent(op, channel, { ...r.detail, observation: structuredClone(r.value) });
      return evidenceSince(first, r.value);
    } catch (err) {
      refuse(op, channel, err);
    }
  };

  // Only the declared preference fields exist; anything else would be an
  // attempt to smuggle in an amount, identity, time or instruction override.
  const parsePrefs = (raw         )                                                  => {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('discovery preferences must be an object');
    const o = raw                           ;
    for (const k of Object.keys(o)) {
      if (!PREF_FIELDS.has(k)) throw new Error(`unsupported preference field: ${k}`);
    }
    const prefs                                                  = {};
    if (o.tags !== undefined) {
      if (!Array.isArray(o.tags) || o.tags.some((t) => !isNonEmptyString(t))) {
        throw new Error('tags must be non-empty strings');
      }
      prefs.tags = [...o.tags];
    }
    if (o.maxWalkingMinutes !== undefined) {
      if (!isFiniteNumber(o.maxWalkingMinutes) || o.maxWalkingMinutes < 0) {
        throw new Error('maxWalkingMinutes must be a finite non-negative number');
      }
      prefs.maxWalkingMinutes = o.maxWalkingMinutes;
    }
    return prefs;
  };

  // Discovery shows only offers live now; a retained response can never
  // extend validity — evaluate/select re-check the window at the clock.
  const discoverImpl = (raw         )                                                          => {
    const prefs = parsePrefs(raw);
    const offers = catalog
      .filter(offerLive)
      .filter((o) => prefs.tags === undefined || prefs.tags.every((t) => o.tags.includes(t)))
      .filter((o) => prefs.maxWalkingMinutes === undefined || o.walkingMinutes <= prefs.maxWalkingMinutes)
      // Deterministic tie-break: a codepoint comparison, so ordering is
      // reproducible regardless of the host locale (unlike localeCompare).
      .sort((a, b) => a.priceCents - b.priceCents || (a.offerRef < b.offerRef ? -1 : a.offerRef > b.offerRef ? 1 : 0))
      .map(offerView);
    return { value: offers, detail: { offers: offers.map((o) => o.offerRef), preferences: prefs } };
  };

  const evaluateImpl = (raw         )                                                        => {
    const o = offerByRef(raw);
    // A fresh-purchase projection from the coordinator: the session never
    // computes shares itself and the agent cannot supply terms.
    const q = coordinator.quote({
      merchantId: o.merchantId,
      totalCents: o.priceCents,
      employeeId,
      feesCents: employeeFeeCents,
      mandateRef,
    });
    const reasons               = [];
    // The allowlist is fixed by the plan and has no label for a window that
    // has not opened yet, so 'offer_expired' is asserted only once now has
    // passed until. A not-yet-live offer adds no fabricated reason: the view
    // still carries availability/retrievedAt showing the window, and
    // selecting it refuses precisely (offer_not_yet_available).
    if (now() > o.availability.until) reasons.push('offer_expired');
    const safe = safeReason(q.ineligibleReason);
    if (safe) reasons.push(safe);
    if (q.assessment.authZone === 'Exception') reasons.push('personal_limit_exceeded');
    if (q.assessment.authZone === 'Blocked') reasons.push('merchant_blocked');
    const value            = {
      offer: offerView(o),
      totalCents: o.priceCents,
      personalCents: q.employeeCents,
      othersCents: q.employerCents,
      employeeFeeCents,
      authZone: q.assessment.authZone,
      autoPayBlockedReason: q.assessment.autoPayBlockedReason,
      employeeMaxCents: q.assessment.mandate?.maxCents,
      mandateVersion: q.assessment.mandate?.version,
      reasons,
    };
    return { value, detail: { offerRef: o.offerRef } };
  };

  // The current purchase as the employee may see it. Amounts come from the
  // retained proposal — after submission they are never replaced by a new
  // quote, so an explanation always describes the approved terms. Zone and
  // reason come from the coordinator's read-only current assessment, so a
  // projection never emits an authority event just to display one; the
  // assessment recorded at the last mutation stays on payer.assessment and
  // the basis that actually funded stays on the authorization records.
  const presenterView = ()                => {
    const p = requirePurchase();
    const o = selectedOffer();
    if (!o) throw new Error('no_proposal');
    // The presenter is benefit-only: a fund or charity purchase — or any
    // authorization basis it does not model — is an arrangement it refuses
    // outright, before assessment or projection. It learns no pledge
    // actions and no new disclosure.
    if (p.funding !== undefined || p.charity !== undefined || p.authorizations.some((a) => a.basis === 'pledge')) {
      throw new Error('arrangement_not_supported');
    }
    const reasons = new Set            ();
    // 'draft' exists only because the standing terms block this merchant.
    if (p.state === 'draft' && p.reason === 'blocked_merchant') reasons.add('merchant_blocked');
    const assessment = coordinator.assess(purchaseId);
    if (assessment.authZone === 'Exception') reasons.add('personal_limit_exceeded');
    if (assessment.authZone === 'Blocked') reasons.add('merchant_blocked');
    // Offer expiry is meaningful only while the purchase is still open.
    if (SELECTABLE.includes(p.state) && now() > p.proposal.expiresAt) reasons.add('offer_expired');
    if (p.state === 'failed' && typeof p.reason === 'string') {
      const i = p.reason.indexOf(':');
      const head = i === -1 ? p.reason : p.reason.slice(0, i);
      const tail = i === -1 ? '' : p.reason.slice(i + 1);
      if (head === 'employer_authority_invalid') reasons.add(safeReason(tail) ?? 'benefit_unavailable');
      if (head === 'approval_expired') reasons.add('approval_expired');
      if (head === 'offer_expired') reasons.add('offer_expired');
      // Deliberately no catch-all: unmapped heads like
      // 'approval_signature_invalid:<payer>' carry detail (a payer id, a
      // signature verdict) nothing in the allowlist can safely name, so
      // reasons stays empty rather than project a wrong label. The failure
      // is still conveyed by payer.state and the leg statuses.
    }
    let approvalExpired = false;
    // One verified standing-terms read for the whole authorization list:
    // every entry's liveness is projected against the same record.
    const standing = p.benefit ? coordinator.employeeMandate(p.benefit.employeeId) : undefined;
    const authorizations                              = p.authorizations.map((a) => {
      // Unreachable while presenterView refuses pledge arrangements above —
      // kept explicit so a pledge record can never fall into .approval
      // reads if that guard is ever bypassed.
      if (a.basis === 'pledge') throw new Error('arrangement_not_supported');
      if (a.basis === 'mandate') {
        const binds = a.proposalVersion === p.proposal.version;
        return {
          basis: 'mandate',
          payerId: a.payerId,
          mandateVersion: a.mandate.payload.version,
          proposalVersion: a.proposalVersion,
          bindsCurrentProposal: binds,
          // Liveness under the coordinator's own survival rule: revocation
          // or a superseding revision after recording makes this false even
          // while the proposal binding still matches.
          currentlyValid: coordinator.authorizationCurrentlyValid(purchaseId, a, standing),
        };
      }
      if (now() > a.approval.payload.expiresAt) approvalExpired = true;
      const binds = a.approval.payload.proposalVersion === p.proposal.version;
      return {
        basis: a.basis,
        payerId: a.approval.payload.payerId,
        approvalRef: a.approval.payload.approvalRef,
        expiresAt: a.approval.payload.expiresAt,
        proposalVersion: a.approval.payload.proposalVersion,
        bindsCurrentProposal: binds,
        currentlyValid: coordinator.authorizationCurrentlyValid(purchaseId, a, standing),
      };
    });
    if (approvalExpired) reasons.add('approval_expired');
    const payer = viewFor(p, { partyId: employeeId, facet: 'payer' });
    // The benefit-only guard above already refused funds and pledge-backed
    // arrangements; narrow the union result statically — a fund's
    // FundPayerView never reaches this benefit shape.
    if (!('totalCents' in payer)) throw new Error('arrangement_not_supported');
    return {
      payer,
      offerRef: o.offerRef,
      offer: offerView(o),
      proposalVersion: p.proposal.version,
      proposalExpiresAt: p.proposal.expiresAt,
      authZone: assessment?.authZone,
      autoPayBlockedReason: assessment?.autoPayBlockedReason,
      employeeMaxCents: assessment?.mandate?.maxCents,
      mandateVersion: assessment?.mandate?.version,
      authorizations,
      reasons: [...reasons],
    };
  };

  const explainImpl = ()                                                            => {
    // Before the first selection there is nothing to explain.
    return { value: presenterView(), detail: {} };
  };

  // Which key signs this channel's lifecycle requests, and who it names:
  // the agent channel signs as the session's agent under the stored grant,
  // the trusted channel as the employee's own device key.
  const signerFor = (channel                  )                                                                           => {
    if (channel === 'agent') {
      if (signAsAgent === undefined) throw new Error('no_agent_signer');
      return { by: agentId, sign: signAsAgent };
    }
    return { by: employeeId, sign: signAsPrincipal };
  };

  const selectImpl = (raw         , channel                  )                                                            => {
    const o = offerByRef(raw);
    if (!offerLive(o)) throw offerWindowError(o);
    const { by, sign } = signerFor(channel);
    const terms = { merchantId: o.merchantId, totalCents: o.priceCents, expiresAt: o.availability.until };
    if (!created) {
      // First selection creates the session's one purchase under the fixed
      // instruction. The proposal expiry is the offer's own deadline. The
      // agent channel attaches the session's stored grant — the employee's
      // signed delegation the coordinator verifies end to end.
      const payload                        = {
        kind: 'propose',
        purchaseId,
        proposalVersion: 1,
        by,
        employeeId,
        merchantId: terms.merchantId,
        totalCents: terms.totalCents,
        feesCents: employeeFeeCents,
        mandateRef,
        expiresAt: terms.expiresAt,
        submitPolicy,
        settlementMode,
        // The session's fixed benefit request names its restrictive
        // profile — the agent interface never selects disclosure.
        privacyProfile: 'employer_benefit_v1',
        grant: channel === 'agent' ? (grant                      ) : undefined,
      };
      coordinator.propose(sign(payload));
      created = true;
    } else {
      // Terms are locked once money may have moved; only pre-submission
      // states are selectable. The signed change request binds the current
      // version; it bumps the proposal version and invalidates earlier
      // approvals.
      const p = requirePurchase();
      if (!SELECTABLE.includes(p.state)) throw new Error(`not_selectable:${p.state}`);
      const payload                     = {
        kind: 'change_offer',
        purchaseId,
        proposalVersion: p.proposal.version,
        by,
        merchantId: terms.merchantId,
        totalCents: terms.totalCents,
        expiresAt: terms.expiresAt,
      };
      const change = coordinator.changeOffer(purchaseId, sign(payload));
      if (change.outcome === 'failed') {
        return { value: presenterView(), detail: { offerRef: o.offerRef, outcome: change.outcome, reason: change.reason } };
      }
    }
    selectedOfferRef = o.offerRef;
    return { value: presenterView(), detail: { offerRef: o.offerRef } };
  };

  // The version the user saw must still be the live proposal, and the offer
  // behind it must still be live, before approval or submission proceeds.
  const checkVersionAndOffer = (expectedProposalVersion        )               => {
    const p = requirePurchase();
    if (!Number.isInteger(expectedProposalVersion) || p.proposal.version !== expectedProposalVersion) {
      throw new Error('stale_proposal');
    }
    const o = selectedOffer();
    // A missing offer or a lapsed proposal deadline is expiry; a window that
    // has not opened yet is refused precisely rather than as 'expired'.
    if (!o || now() > p.proposal.expiresAt) throw new Error('offer_expired');
    if (!offerLive(o)) throw offerWindowError(o);
    return p;
  };

  const approveImpl = (expectedProposalVersion        , choice                          )                                                            => {
    const p = checkVersionAndOffer(expectedProposalVersion);
    // The device callback signs exactly the retained proposal — including a
    // signed exception acknowledgment when the choice is made; the
    // coordinator enforces every binding again.
    approveOnDevice(p, choice);
    return { value: presenterView(), detail: {} };
  };

  const submitImpl = async (expectedProposalVersion        )                                                                     => {
    checkVersionAndOffer(expectedProposalVersion);
    // The employee's signed submit request, bound to the version they saw:
    // the proposal itself carries the settlement mode.
    const payload                       = { kind: 'submit', purchaseId, proposalVersion: expectedProposalVersion, by: employeeId };
    await coordinator.submit(purchaseId, signAsPrincipal(payload));
    return { value: presenterView(), detail: {} };
  };

  // The employee's signed pre-submission cancel, bound to the current
  // version — like every trusted op it runs through the audited channel.
  const cancelImpl = ()                                                            => {
    const p = requirePurchase();
    const payload                = { kind: 'cancel', purchaseId, proposalVersion: p.proposal.version, by: employeeId };
    coordinator.cancel(purchaseId, signAsPrincipal(payload));
    return { value: presenterView(), detail: {} };
  };

  const reconcileImpl = async ()                                                                     => {
    requirePurchase();
    await coordinator.reconcile(purchaseId);
    return { value: presenterView(), detail: {} };
  };

  // The verified standing terms as the employee may see them — detached by
  // the coordinator already; this view additionally drops the reference,
  // signature and key material.
  const termsView = ()                                => {
    const current = coordinator.employeeMandate(employeeId);
    if (!current) return undefined;
    const m = current.payload;
    return {
      version: m.version,
      maxCents: m.maxCents,
      autoPayMaxCents: m.autoPayMaxCents,
      autoPayMonthlyCents: m.autoPayMonthlyCents,
      trustedMerchants: [...m.trustedMerchants],
      blockedMerchants: [...m.blockedMerchants],
      validUntil: m.validUntil,
      revoked: m.revoked,
    };
  };

  // The current verified record, or the refusal every revision convenience
  // shares: with nothing accepted there is nothing to revise.
  const requireTerms = ()                  => {
    const current = coordinator.employeeMandate(employeeId);
    if (!current) throw new Error('no_employee_mandate');
    return current.payload;
  };

  const revokeMandateImpl = ()                                                                => {
    const current = requireTerms();
    // Already revoked is a harmless observation — like an already trusted
    // merchant, it earns no redundant revision.
    if (current.revoked) return { value: termsView() , detail: {} };
    // The device callback merges this change into the verified record, signs
    // the next revision and publishes it; the registry validates again.
    updateEmployeeMandateOnDevice({ revoked: true }, employeeId);
    const after = requireTerms();
    if (after.version === current.version || !after.revoked) throw new Error('mandate_revision_not_published');
    return { value: termsView() , detail: {} };
  };

  const trustMerchantImpl = (raw         )                                                                => {
    if (!isNonEmptyString(raw)) throw new Error('merchant id must be a non-empty string');
    const current = requireTerms();
    // A block beats trust until a full terms edit removes it; never let a
    // convenience widen what the signed record forbids.
    if (current.blockedMerchants.includes(raw)) throw new Error('merchant_blocked');
    if (current.trustedMerchants.includes(raw)) return { value: termsView() , detail: { merchantId: raw } };
    updateEmployeeMandateOnDevice({ trustedMerchants: [...current.trustedMerchants, raw] }, employeeId);
    const after = requireTerms();
    if (after.version === current.version || !after.trustedMerchants.includes(raw)) {
      throw new Error('mandate_revision_not_published');
    }
    return { value: termsView() , detail: { merchantId: raw } };
  };

  // The employee's dispute on this session's purchase: the principal is the
  // session's own employee — a caller can never dispute someone else's.
  const disputeImpl = async ()                                                                     => {
    requirePurchase();
    await coordinator.dispute(purchaseId, employeeId);
    return { value: presenterView(), detail: {} };
  };

  // One deterministic runner step over the session's own purchase: refresh
  // the open assessment under current standing terms, then either dispatch
  // under currently valid mandate evidence or resolve the pending purchase
  // through its frozen intent. Every other state — awaiting a device
  // signature, blocked, failed, cancelled, completed — is a harmless
  // repeated observation; a step never approves, proposes or starts a
  // manual payment.
  const stepImpl = async ()                                                                     => {
    const p = requirePurchase();
    if (SELECTABLE.includes(p.state)) coordinator.refreshAuthorization(purchaseId);
    if (p.state === 'ready' && p.proposal.submitPolicy === 'on_request') {
      // Initiate only under currently valid standing-mandate evidence: a
      // device or exception approval marks a manual purchase the runner
      // never dispatches, and stale evidence was already dropped above.
      // Under 'on_ready' the coordinator fired its own submission at the
      // ready transition — a step never submits there.
      const a = p.authorizations.find((x) => x.basis === 'mandate');
      if (a !== undefined && coordinator.authorizationCurrentlyValid(purchaseId, a)) {
        const payload                       = { kind: 'submit', purchaseId, proposalVersion: p.proposal.version, by: employeeId };
        await coordinator.submit(purchaseId, signAsPrincipal(payload));
      }
    } else if (p.state === 'pending') {
      // Status queries first — they resolve every leg that kept a
      // reference. A leg still unknown with none, or one conclusively
      // refused before forwarding, can only be resolved by replaying the
      // frozen submission: same keys, same terms, never a new payment.
      await coordinator.reconcile(purchaseId);
      const unresolved =
        p.submission?.legs.some((l) => l.dispatch !== 'forwarded') === true ||
        p.legs.some((l) => l.status === 'unknown' && l.executionRef === undefined);
      if (p.state === 'pending' && unresolved) await coordinator.resubmit(purchaseId);
    }
    return { value: presenterView(), detail: {} };
  };

  // Agent path: verify the grant (signature, expiry, binding, capability)
  // before anything else. Failures deny generically and are audited.
  const agentCall =    (op        , cap                 , fn                                                      )              => {
    const problem = grantProblem(cap);
    if (problem) deny(op, problem);
    checkFree(op, 'agent');
    return run(op, 'agent', fn);
  };

  const agent                 = {
    discover: (prefs) => agentCall('discover', 'discover', () => discoverImpl(prefs)),
    evaluate: (offerRef) => agentCall('evaluate', 'explain', () => evaluateImpl(offerRef)),
    selectOffer: (offerRef) => agentCall('select', 'propose', () => selectImpl(offerRef, 'agent')),
    explain: () => agentCall('explain', 'explain', () => explainImpl()),
  };

  // Trusted path: the same private implementations without the grant check.
  // submit/reconcile hold the in-flight guard from before the first await
  // until finally, so no session operation — including snapshot — can run
  // while the coordinator awaits a settlement response.
  const userFlow                    = {
    discover: (prefs) => {
      checkFree('discover', 'user');
      return run('discover', 'user', () => discoverImpl(prefs));
    },
    evaluate: (offerRef) => {
      checkFree('evaluate', 'user');
      return run('evaluate', 'user', () => evaluateImpl(offerRef));
    },
    selectOffer: (offerRef) => {
      checkFree('select', 'user');
      return run('select', 'user', () => selectImpl(offerRef, 'user'));
    },
    explain: () => {
      checkFree('explain', 'user');
      return run('explain', 'user', () => explainImpl());
    },
    approve: (expectedProposalVersion, opts) => {
      checkFree('approve', 'user');
      return run('approve', 'user', () => approveImpl(expectedProposalVersion, opts));
    },
    submit: async (expectedProposalVersion) => {
      checkFree('submit', 'user');
      inFlight = true;
      try {
        return await runAsync('submit', 'user', () => submitImpl(expectedProposalVersion));
      } finally {
        inFlight = false;
      }
    },
    cancel: () => {
      checkFree('cancel', 'user');
      return run('cancel', 'user', () => cancelImpl());
    },
    reconcile: async () => {
      checkFree('reconcile', 'user');
      inFlight = true;
      try {
        return await runAsync('reconcile', 'user', () => reconcileImpl());
      } finally {
        inFlight = false;
      }
    },
    terms: () => {
      checkFree('terms', 'user');
      return run('terms', 'user', () => ({ value: termsView() }));
    },
    revokeMandate: () => {
      checkFree('revoke_mandate', 'user');
      return run('revoke_mandate', 'user', () => revokeMandateImpl());
    },
    trustMerchant: (merchantId) => {
      checkFree('trust_merchant', 'user');
      return run('trust_merchant', 'user', () => trustMerchantImpl(merchantId));
    },
    dispute: async () => {
      checkFree('dispute', 'user');
      inFlight = true;
      try {
        return await runAsync('dispute', 'user', () => disputeImpl());
      } finally {
        inFlight = false;
      }
    },
    snapshot: () => {
      checkFree('snapshot', 'user');
      // Through run(), so a refusal (no proposal yet) is audited like every
      // other operation. The view unwraps to its record before cloning —
      // structuredClone would DataCloneError on the live proxy.
      return run('snapshot', 'user', () => ({ value: structuredClone(unwrapView(requirePurchase())) })).value;
    },
  };

  // The trusted runner: same guard as submit/reconcile/dispute — a step
  // holds it from before the refresh until the returned observation is
  // detached, so no manual or agent operation can interleave mid-step.
  const runner                  = {
    step: async () => {
      checkFree('step', 'user');
      inFlight = true;
      try {
        return await runAsync('step', 'user', () => stepImpl());
      } finally {
        inFlight = false;
      }
    },
  };

  return { agent, userFlow, runner };
}
