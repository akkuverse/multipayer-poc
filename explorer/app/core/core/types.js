// GENERATED from src/core/types.ts — type-stripped build artifact; never hand-edit.
// Shared types for the multi-payer mock. All amounts are integer euro cents.

                                                     
                                           
                                                                 

                           

// LOCAL = produced by this mock or the coordinator. ECB_API is reserved for
// events observed through the ECB test environment once access exists.
                                         

// Lifecycle: draft → awaiting_approvals → ready → pending → completed.
// 'failed' = nothing was committed; 'cancelled' = every obligation resolved;
// 'compensated' = automatic compensation and all cleanup confirmed, charged
// fees included; 'recovery_required' = money committed but the purchase
// incomplete, with the outstanding amount kept visible until returned.
                           
           
                        
           
             
               
            
               
                 
                        

// Per-contribution outcome. 'unknown' means the submission response was lost:
// a timeout is not evidence of failure. 'returned' means settled then
// refunded; a return never erases the original settlement record.
                                                                                    

// Whether returns were attempted on this purchase and how they ended. Tracked
// separately from the purchase state because a return is a new operation on an
// old settlement, not a rewrite of it. 'partial' means at least one leg is
// confirmed returned while others remain outstanding — it releases nothing:
// only 'completed' gives the purchase's holds back.
// 'unresolved' records an uncertain return with no confirmed returned leg;
// 'partial' records confirmed returned principal with other legs outstanding.
                                                                                           

// 'atomic' reserves every leg before any commit and compensates committed
// payments on conclusive failure — reserve-all with compensation across the
// two ledgers, not a single cross-ledger transaction. 'independent' is the
// two-payment baseline where each leg settles on its own, a failed leg is
// cleaned up and committed legs are returned only by explicit recovery.
                                                      

// The rail a share pays on. Digital-euro holdings and bank balances live on
// different ledgers, so a share's rail is part of its signed terms — like
// settlementMode — and can never be silently substituted.
                                           

// The recognized rails; a value outside this union is refused, never
// reinterpreted.
export const RAILS                  = ['digital_euro', 'bank'];

// How a 'ready' purchase reaches submission. 'on_request': a payer's signed
// submit request starts settlement — the coordinator submits only on that
// caller's instruction. 'on_ready': the coordinator fires its own
// submission the moment the purchase becomes ready; no request exists, and
// the coordinator's own path is the only request-less submission — a
// caller's submit() still needs a signed request.
                                                     

// Where a split proposal's share amounts came from. 'proposer': the shares
// carry explicit amounts and the proposer's signature over them doubles as
// their approval of their own shares. 'equal_split': the request carries a
// total and amount-less shares; the coordinator computes the split with the
// fixed remainder rule and every payer still approves separately.
                                                     

// Every call that starts or ends a purchase names its caller. The payload
// the caller signs binds the operation to one purchase and one committed
// proposal version, so a replayed or retargeted request can never act on
// terms the signer did not see. 'open_fund' is the payee's one request that
// opens a conditional-fund campaign — the mandate-publication analog, not a
// negotiated proposal.
                                                                                                                      

// The binding every lifecycle request payload carries: which operation,
// which purchase, which committed proposal version the signer saw, and who
// the signer claims to be. proposalVersion is 1 for a proposal creating a
// purchase (no committed version exists yet) and the current version for
// change/cancel/refund/submit.
                                
                    
                     
                          
             
 

// An employee's delegation of proposal work to an agent, signed under the
// employee's registered key and scoped to one purchase and session. The
// coordinator verifies the grant end to end — signature, agent, principal,
// purchase, capability, expiry — because the session's claim alone is not
// authority. The presenter's AgentGrant structurally satisfies this shape.
                                  
                   
                  
                      
                    
                     
                         
                    
 

// A signed employer-benefit proposal. by === employeeId suffices; any other
// signer must be an agent carrying grant — the employee's DelegationGrant
// for this purchase, verified at proposal time.
                                                              
                  
                     
                     
                    
                    
                     
                    
                             
                                 
                                                                           
                                                                           
                                                                         
                                        
                                  
 

// A signed anonymous-charity proposal (spec §3.2): the attested buyer asks
// the coordinator to find a matching donor allowance for its beneficiary
// class — there is no mandateRef to name, and the signer can supply no
// grant, fees, shares, rails or allocation override: the coordinator
// derives every share term itself rather than honoring unsigned donor
// debit terms. Only the buyer may sign this variant — an agent's
// delegation cannot stand in for the beneficiary's own request.
                                                              
                  
                                                               
                     
                     
                    
                    
                             
                                 
                                                 
                                          
                                                                    
                
                       
 

// A signed benefit or charity proposal, discriminated on its disclosure
// profile — the 'propose' kind's own SplitRequest-style union. An agent
// delegation exists only on the benefit member.
                                                                           

// The fields every signed split request carries; the amounts rule then
// discriminates it into the two shapes below, so an ambiguous payload —
// amounts on 'equal_split' shares, or a total contradicting 'proposer'
// shares — is unrepresentable to typed callers and refused outright to
// signers.
                                                  
                        
                     
                    
                             
                                 
                                                                           
                                                                      
                                                                 
                                                                         
                                  
                             
 

// 'proposer' amounts: every share carries its explicit amount and the
// proposer's signature over them doubles as their approval of their own
// shares. totalCents is redundant — allowed only equal to the share sum,
// never a second source of amounts.
                                                                
                          
                                                                                                                  
                     
 

// 'equal_split' amounts: the request carries a total and amount-less
// shares; the coordinator computes the split with the fixed remainder rule
// and every payer still approves separately.
                                                             
                             
                                                                                                                   
                    
 

// A signed split proposal, discriminated on where its amounts come from.
// The signer must be one of the shares' payers.
                                                                    

// A signed offer change, bound to the version it replaces. Signers: the
// merchant of record, the current proposal's proposer, or the employee.
                                                           
                       
                     
                    
                    
 

// A signed pre-submission cancellation; any payer of the purchase may sign.
                                                      
                 
 

// A signed post-completion return request; only a payee of the purchase may
// sign — a payer's return path is dispute(), never refund().
                                                      
                 
 

// A signed submission request; any payer may sign. A caller's submit()
// requires one under either policy — under 'on_ready' the coordinator's
// own submission is the only request-less path. Named to stay distinct
// from the frozen SettlementLeg terms handed to the orchestrator.
                                                             
                 
 

// --- Conditional funds -----------------------------------------------------
// A fund is a purchase whose share set grows through individually signed
// pledges under immutable campaign terms. The payee opens it with one
// signed request; pledgers join it; the coordinator resolves it
// deterministically on its simulated clock.

// Every signed campaign term an open_fund request fixes, purchaseId
// included. Campaign terms comprise exactly this table — envelope metadata
// (kind, by, proposalVersion) is never part of them — and campaignDigestOf
// commits to all of it, so a pledge signature binds the cutoff, settlement
// deadline, closing rule, submission policy, mode and profile it was made
// under, with no omitted defaults.
                                
                     
                  
                                                                     
                                                                          
                                                                          
                   
                                                           
                                                                         
                        
                                                                      
                                                                        
                   
                                                                  
                                                                          
                        
                                                   
                             
                                                               
                           
                                          
 

// The campaign payee's one signed request that opens a fund: the signer is
// the public-good recipient and the purchase's merchant of record. After
// open, the terms never change; a second open_fund for the same purchaseId
// is refused as duplicate_purchase.
                                                                       
                    
                     
 

// One contributor's signed pledge — its own approval of its complete share
// under the campaign it names. Deliberately NOT a SignedRequest variant: it
// carries no proposalVersion (the roster version is irrelevant to its
// binding) and binds the campaign digest, its own pledge identity and
// expiry instead — never the complete roster.
                                
                 
                     
                                           
             
                                                                        
                                                                      
                    
                                                              
                         
                                                                
                                                        
          
                 
                    
                    
                       
                    
               
    
                                                                     
                                                                   
                                        
                    
                                          
 

// The detached acknowledgment a returned pledge earns: acceptance time and
// the proposal version the pledge was recorded under. It never changes when
// the pledge later lapses — current outcome lives in the acceptance history.
                                   
                     
                    
                     
                          
 

// One accepted pledge's retained evidence: the signed request, the exact
// canonical payload it was accepted under (replay compares bytes), the
// detached acknowledgment and its current outcome. History is retained
// after lapse — lapsed pledges never count toward the condition but their
// acceptance is never erased.
                                 
                                
                           
                                   
                               
 

// The fund's retained lifecycle state on its purchase: the verified opening
// request and the terms it committed, the phase the funding decision owns
// (collecting under 'awaiting_approvals'; closed under 'ready' before any
// admitted intent; admitted once settlement owns the outcome), the full
// acceptance history, and the live progress counters the last decision
// computed. Active shares and authorizations are coordinator-applied
// materializations of the 'active' history entries.
                               
                                    
                         
                       
                                              
                            
                                                                        
 

// Who a share's funding authority belongs to. 'payer': the named payer
// authorises their own shares — by a device signature, a signed one-off
// exception, or employee standing terms. 'employer_mandate': funded under
// the employer's standing, bounded mandate, rechecked at initiation.
// 'sponsor_mandate': funded under a donor's standing allowance for an
// attested beneficiary class, rechecked at initiation the same way.
                                                                             

// One payer's part of a proposal.
                        
                                                                       
               
                  
                                                            
                  
                     
                                                                                     
                  
                                                                       
                                                                  
                                                                          
             
                           
                                                                     
                                                                      
                                                                           
                                                                           
                                     
                        
 

// The current offer and how it is funded. The version bumps on every change
// and is what approvals bind to, so a changed offer can never be executed
// under a stale approval.
                           
                  
                                                 
                     
                    
                  
                                                                        
                    
                                                                      
                                                            
                     
                                                                           
                                                                
                             
                                                                   
                                                                         
                                 
                                                                    
                                                        
                            
                                                                       
                                                                           
                                                                           
                        
 

// One payer's approval, bound to one proposal version and its exact terms:
// every field is part of the binding checked in approve().
                                
                      
                     
                  
                          
                     
                    
                                                                             
                                                                    
                     
                                                
                  
                                                                            
                                                                            
                                                                         
                                               
                       
                                                                            
                                                                          
                                                                      
                                   
                                   
                              
                                                            
                    
                                                                       
                                                                              
                                                                           
                                                                         
                       
                                                                            
                                                                          
                                                                      
                                                                
                   
                      
                          
                   
                      
 

                                                   

// Employee authorization as a discriminated record (spec §5): a
// coordinator-generated mandate authorization is not Signed<PayerApproval>
// and is never passed off as one.
                           
     
                                                                            
                      
                                      
     
     
                                                                       
                                                                  
                         
                                      
     
     
                                                                           
                                                                             
                                                                            
                       
                      
                                       
                              
                                
     
     
                                                                        
                                                                          
                                                                   
                                                                         
                                                        
                      
                                    
      

// The disclosure terms a proposal froze at commit: which versioned profile
// governs its recipient projections and which verified source it was
// resolved from. 'request_only' is the conservative form when no usable
// employer mandate — or, under 'anonymous_donation_v1', no positive donor
// allowance — exists: the signed restrictive request stands, but it
// authorizes no sponsor share and entitles no sponsor. 'known_group'
// records the trusted group agreement a split was admitted under and the
// actual purchase audience — the distinct payers the shares name.
// 'allowance' records the selected donor allowance a charity proposal was
// matched under: the reference, the accepted revision and the donor the
// coordinator verified — internal provenance, never copied into a
// recipient view.
                          
     
                                     
               
                                 
                           
                               
                           
        
     
                                                                        
     
                               
               
                            
                         
                                 
        
     
     
                                       
                                                                        
                                                                       
                                               
               
                         
                               
                             
        
     
     
                                       
               
                          
                             
                                                                  
                        
                        
        
     
                                                                           

// Bounded employer authority, granted independently of any single purchase.
// A policy match alone is not spending authority; this object is.
                                  
                     
                     
                                                                    
                                                                           
                                   
                  
                                                                               
                         
                             
                        
                                                                             
                                                                        
                             
                              
                    
                     
                   
                                                                         
                                                                      
                                                        
                                        
 

// The employee's signed standing payment terms. One record per employee,
// replaced only by the employee signing the next version: revocation and
// expiry disable automatic authority but keep the maximum and the blocked
// list in force until the terms are explicitly replaced. A mandate reference
// stays bound to the employee that first published it.
                                  
                                                                           
                                           
                     
                                                        
                     
                                                                          
                    
                  
                                                                            
                                         
                         
                                                                          
                                                              
                  
                                                                  
                             
                                                 
                             
                                                                             
                             
                                                                            
                                                                        
                                                                          
                                                  
                       
                                                                            
                      
                     
                                                                              
                   
 

// --- Anonymous charity ------------------------------------------------------
// A donor's standing allowance for an attested beneficiary class — the
// EmployerMandate analog whose beneficiary is a class instead of a named
// beneficiaryRef. Published through the same registry under the same
// verify-at-publish-and-use discipline: the first donor permanently owns
// the reference, class and donor identity are immutable, other terms
// (caps, window, revocation) revise only through the next version, and
// budget usage survives revisions and revocation.
                                   
                                                               
                                                                         
                       
                                                                           
                                                                      
            
                  
                                                                    
                                                                           
                                   
                  
                                                                  
                                           
                           
                             
                        
                                                                             
                             
                                                           
                              
                              
                    
                     
                   
                                                                        
                                                                        
                                                        
                                          
 

// An oracle's signed statement that one subject belongs to a beneficiary
// class for a validity window. Stored by (subjectId, classId); replaced or
// revoked only by the next version from the class's configured attestor —
// holding a registered signing key grants no attestation privilege on its
// own.
                                         
                                                          
                     
                                            
                    
                                                                 
                  
                    
                     
                                                                           
                                               
                  
                   
 

// Where a proposal stands relative to the employee's standing terms (spec
// §4). 'Blocked' cannot be paid through this flow at all; 'Exception' needs a
// device signature that explicitly acknowledges exceeding the maximum;
// 'Auto' may pay without a tap under the signed terms; 'Confirm' is every
// other payable proposal, including never having a mandate.
                                                                    

// The first applicable reason a proposal is not Auto, in spec §4 precedence
// order — extended with 'rail_not_permitted' for a debit whose rail the
// standing terms never allowed. Blocked proposals always carry
// 'blocked_merchant'; Auto carries none.
                                  
                      
                         
                     
                        
                     
                     
              
                     
                        
                 
                      

// A point-in-time answer to "which authority does this employee debit need
// right now". Stored on a benefit purchase as employeeAssessment and exposed
// alongside the proposal version; a projection, never authority itself.
                                     
                     
                                                                             
                         
                            
                                                                          
                                                                   
                                                                     
                                              
 

// Whether a leg's request may have reached its settlement route, tracked on
// the frozen submission independently of any returned execution reference.
// 'forwarded': a route call ran — its response may have been lost, so the leg
// stays potentially submitted and a replay uses its frozen authorization.
// 'planned': a handoff was attempted but its reserve never reported reaching
// the provider — the leg is not known to be forwarded, so a replay resumes
// the frozen first handoff under the same key.
// 'refused': conclusively refused before forwarding — a replay is again a
// first handoff and is revalidated under current authority.
                                                              

// A request leg frozen at admission: the exact terms the settlement route
// dedupes on, the kind of authority that funds it (approval recheck vs mandate
// recheck — never inferred from the authorityRef string), and its dispatch
// knowledge. Absent dispatch means never attempted.
                                
                  
                  
                     
                  
                                                                            
                                
             
                         
                           
                                                                           
                                                                            
                                                                         
                                            
                                                                        
                                                                          
                                                                     
                                 
                         
 

// The sponsor admission evidence a charity submission froze: the selected
// allowance reference and its donor, the booking day the allowance
// reservation was filed under (a still-unsent donor leg's recheck counts
// THAT day's usage even after the clock crosses midnight, excluding only
// this purchase's own booking), and the detached signed records the
// admission verified — the allowance revision, the buyer's attestation and
// the buyer's consent. The allowance and attestation snapshots refresh to
// the exact current revisions at an unstarted donor first handoff, then
// stay frozen through forwarding and replay — parallel to employerMandate
// on a mandate-funded leg, but never a fresh arrangement: the reference,
// donor and amount are the same ones the proposal committed.
                                   
                       
                  
                     
                                      
                                              
                                       
 

// The submission as admitted, frozen for the purchase's whole settlement
// life: a replay hands the orchestrator these exact values — group, mode,
// request legs and authority evidence — never fresh terms or fresh keys.
                             
                   
                       
                        
                                                                           
                                                                        
                                                                            
                                                                 
                        
                                                                     
                                                                         
                                                     
                             
 

// One contribution attempt. Which authority paid for it is recorded in
// authorityRef (the payer's approvalRef, or the employer's mandateRef), so
// every euro traces back to a specific grant of authority.
                      
                                        
              
                  
                  
                     
                                                              
                  
                                                         
             
                       
                                                                       
                                                                      
                         
                    
                                                                           
                 
                        
                        
                                                                            
                                                                          
                                                                     
                                                                          
                                                                    
               
                            
 

// Present on employer-benefit purchases only.
                               
                     
                                                                              
                          
                                                                          
                                                 
                     
 

// Present on anonymous-charity purchases only: the attested buyer and the
// beneficiary class the signed request asked to match, plus — on an
// accepted match — the selected allowance reference and the opaque donor
// identity it funds under. A buyer-only proposal records why no allowance
// contributed instead: the absent/not-live attestation reads
// 'no_live_attestation', an exhausted or ineligible candidate set carries
// the evaluation's own reason. Trusted coordinator evidence — never a
// recipient projection, and never conflated with benefit terms or the
// employee assessment.
                               
                  
                       
                        
                   
                           
 

// The one receipt an automatically authorized purchase earns (spec §9),
// retained at the first observation of full completion: the standing-terms
// revision that authorized the payment, the original amounts, the funding
// breakdown and the fixed dispute deadline. Observation time is used
// because the settlement evidence exposes no commit timestamp; replayed or
// late duplicate outcomes never reissue the receipt or extend the deadline.
                                 
                     
                          
                     
                     
                                                         
                    
                                                                           
                       
                                                                
                     
                  
                    
                                                 
                    
                       
                                                                  
                     
                         
 

// The current outcome of an accepted dispute's return request, derived
// from the purchase return state and per-leg attempt knowledge — never
// inferred from errors alone.
//   opened       — case recorded; no confirmed progress and nothing uncertain
//   unresolved   — a return is in progress or its outcome is uncertain
//   unsupported  — the settlement route reports returns unsupported
//   returned     — every settled share is confirmed returned
                                                                                  

// The employee's accepted dispute case on an Auto purchase: a request for
// the full-purchase return, not proof of one. openedAt records the first
// eligible request; the deadline itself lives on the receipt, so an
// accepted case may finish after the window closes.
                              
                     
                   
                          
 

// The internal coordinator record; never returned across the public seam —
// callers receive PurchaseView.
                           
                     
                                                                           
                                                               
                       
                                                               
                  
                         
                                                                   
                                                                           
                                                                       
                                         
                         
                                                                          
                                                                          
                                                            
                            
                         
                     
                                                                         
                                                                   
                                                                          
                                                                           
                                                   
                                  
                                                                             
                                                                          
                                                                          
                                                                           
                                          
              
                                                                           
                                                                      
                                                                       
                                                            
                          
                                                                   
                                                                             
                                                                          
                        
                                                                         
                                                                         
                                                                  
                                                                           
                        
                             
                                                                      
                                                                             
                           
                                                                          
                                                         
                        
                                                                     
                                                                         
                                                                       
                                                                         
                                  
 

// Every field read-only, recursively: nested objects and arrays cannot be
// written through this type. Structural only — the live proxy behind
// Coordinator.view() is what enforces it.
                                                                     
     
                                  
                                
                      
                                                       
          

// The caller-facing facet of a purchase: the record's live data, read-only.
                                                  

// One line of the audit log shared by the coordinator and the settlement
// modules.
                             
                                                                   
              
                                                                             
                                                                              
                       
                 
                
                
                                                             
                                   
 
