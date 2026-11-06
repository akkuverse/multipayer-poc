// GENERATED from src/settlement/types.ts — type-stripped build artifact; never hand-edit.
// Settlement domain types: the keyed-operation records every settlement
// module keeps for idempotent replay and status, plus the hold lifecycle
// reported separately from operation status. Records crossing a module
// boundary are detached plain data — no mutable Map, module instance or
// callback travels in them. All amounts are integer euro cents.
//
// Owned here so ledger, provider and orchestrator modules share one
// vocabulary; later tasks extend this file with frozen intents, provider
// outcomes and settlement snapshots (contract decisions 5–8).

                                                                                   

// The authoritative status of a recorded operation under its original key.
// 'not_started' is an intent recorded before any attempt — it permits a
// replay under the same key and terms and is never a final rejection.
// 'pending' and 'unknown' are both open: a handed-off operation awaiting its
// outcome, or a lost response — neither proves failure. 'succeeded' and
// 'rejected' are terminal and immutable.
                                                                                               

// The lifecycle of a ledger hold, reported separately from the operation
// that created it: an operation may be resolved while its hold lives on.
                                                                         

// What resolving an operation reports. 'pending' and 'unknown' keep the
// operation open; a 'not_started' outcome is not a resolution at all and is
// refused by the store. The reference, when known, is the module's own
// handle for the attempt (a hold, an execution, a transfer) — the handle
// later status queries and returns key on. reason names a conclusive
// refusal; effects records structured knowledge about what may have moved.
                                   
                                                  
                     
                  
                    
 

// One keyed operation as the store retains it: the immutable copied terms
// the identity dedupes on, the key itself, the current status, and the
// reference/reason/effects evidence accumulated so far. Callers always
// receive detached copies — the retained record is never a mutable handle.
                                  
                                                           
              
                                                                     
                                            
                 
                          
                                                     
                     
                  
                                                                           
                    
 

// ---------------------------------------------------------------------------
// Simulation fault controls (decision 12): concrete modules accept a fault
// per operation key and named stage. 'reject_before_effect' is a conclusive
// refusal before anything moves; 'lose_response_after_effect' applies and
// records the effect but the caller's response is lost — it sees 'unknown'
// and must reconcile by the original key; 'defer' accepts the work as
// 'pending' and parks it until the simulation resolves it explicitly —
// never via a fresh operation key.
                                                                                              

// How the simulation resolves parked work.
                                                   

// The stages a fault can name are the module's actual operations, not an
// abstraction (decision 12).
                                                                                              
                                                   

// ---------------------------------------------------------------------------
// Digital-euro ledger requests (spec §4.3). Every request carries a stable
// operation key, the caller's provider identity and immutable pseudonymous
// terms: the ledger knows pseudonyms only, never payer ids. The recorded
// terms exclude the key, which is the record's identity.

// Frozen group membership recorded on a hold at reserve time: the stable
// group key, this hold's own member identity and the frozen ordered member
// list the key binds (decision 2; spec §7). Member identities are opaque
// strings to the ledger — the caller encodes leg identity into them.
                                    
              
               
                             
 

// Reserve amountCents on a pseudonymous holding for a payment to the
// destination pseudonym. The destination is frozen at reserve: a commit
// cannot redirect the payment.
                                
              
                   
                    
                     
                      
                            
 

// Commit one active hold individually. A hold with frozen group membership
// can only move through commitGroup — committing it alone would break the
// group's all-or-nothing guarantee.
                                  
              
                   
                  
 

// One member of an atomic group commit: the frozen member identity, the
// hold realising it, and the provider authorised for that hold's holding —
// the ledger checks each member against its holding's owning provider.
                                      
              
                  
                   
 

// Commit every listed hold atomically: the ledger validates all members —
// active, unexpired, frozen membership matching this group key and order —
// before changing any holding (decision 2; spec §4.3).
                                       
              
                                          
 

                                   
              
                   
                  
 

// Credit a holding from its owner's bank account (reverse waterfall in).
                                
              
                   
                    
                     
 

// Move digital euro back to the owner's bank account. With transitRef it
// confirms an in-transit excess credit instead of debiting the holding —
// the paired conversion entry for a holding-limited credit (decision 10).
                                  
              
                   
                    
                     
                      
 

// A direct spendable-to-destination move outside the hold flow.
                                    
              
                   
               
             
                     
 

// ---------------------------------------------------------------------------
// Digital-euro ledger result evidence, carried in OperationRecord.effects.

                                
                  
                     
                    
 

// What a destination credit did: the part that became spendable holdings
// and the excess routed into tracked defunding transit (decision 10).
                                  
                       
                       
                      
 

                                                                    

                                       
                                                                           
 

                                   
                  
                                                                        
                                                                  
                         
 

                                            

                                  
                      
                      
 

                                                                          

// ---------------------------------------------------------------------------
// Detached audit views for scenario evidence: balances, holds and transit.

                                 
                    
                   
                 
                           
                                                       
                   
                                                                       
                        
 

                              
                  
              
                    
                     
                      
                     
                     
                    
                                                                      
                                                                    
                                                                          
                         
                            
 

// Excess digital euro routed out of a holding-limited credit, awaiting its
// paired bank credit at the owning provider (decision 10; spec §6.1). It
// is never a spendable balance: 'in_transit' until 'defunded'.
                                 
                     
                    
                    
                     
                                                  
                    
 

// ---------------------------------------------------------------------------
// Interbank transfers (spec §4.4). The module holds nothing per customer:
// it moves bank money between provider books through the BankBook seam the
// provider modules own. A debit alone is transit, not settlement.

// The seam a provider's bank book exposes to the transfer module: debit
// throws with a reason message when the book refuses the amount.
                           
                                  
                                   
 

                                      
              
                                                                          
                                                           
                    
               
             
                     
 

                                      
                      
                   
                    
 

// Detached audit view: which stages are confirmed, and whether an
// uncredited debit has been cancelled back to its source (decision 10).
                                    
                      
              
               
             
                     
                   
                    
                     
 

// ---------------------------------------------------------------------------
// Provider-level records (decisions 7–9, 11; spec §4.1, §6.1, §7). The
// orchestrator hands the provider a frozen leg plus the coordinator's
// accepted authority evidence; the provider answers with detached outcomes
// that carry money truth — committed principal, destination-credit
// confirmation, charged/returned fees, returned principal — and the child
// operations whose effects remain unresolved.

// The frozen leg record (decision 8): its identity is the existing
// (purchaseId, proposalVersion, role) triple, extended with the payer/payee,
// signed rail, principal, fee and authority kind, plus the destination
// routing the payment must follow and — for a leg inside a same-ledger
// digital-euro group — the frozen group membership minted with the intent.
                                
                     
                          
               
                  
                  
             
                        
                  
                                                                         
                                         
                           
                                                                           
                                                                          
                                                           
                                                               
                                                                         
                                                                          
                                                                         
                              
 

// The coordinator's synchronous first-handoff decision, recorded as
// evidence the provider validates against the leg it reserves (decision 7).
// The record echoes the leg identity and terms it authorizes — a provider
// refuses evidence that does not match the leg exactly — and names the
// authority basis and the specific verified grant behind the acceptance.
                                    
                     
                          
               
                  
             
                        
                  
                           
                                                                         
                                                          
                       
 

                               
                                       
                                                    

// The explicit money semantics of a return (decision 9). Automatic
// compensation passes 'principal_and_fee' — principal and any charged fee
// are restored; ordinary refunds, disputes and independent explicit
// recovery pass 'principal_only', preserving the current fee policy.
// Semantics are never inferred by parsing an operation key.
                                                                  

// The provider's handle to one accepted digital-euro group member, returned
// with a group leg's reserve outcome and handed back to
// commitAcceptedDigitalEuroGroup (decision 11). It names the owning
// provider, the acceptance and the ledger hold, and carries the group key
// so the outcome stays recoverable under the original group identity.
                               
                                                                   
                                                                         
                     
                
                   
                                                         
              
                        
                  
                   
                    
 

// One member's commit outcome inside a group commit.
                                     
              
                  
                   
                          
                  
                                                                
                           
 

// The outcome of committing the accepted holds of a frozen digital-euro
// group (decision 11): keyed by the original group key so a lost response
// stays reconcilable, with per-member outcomes and the group operation
// record while it remains unresolved.
                               
              
                          
                  
                                
                                                               
                               
 

// What a provider-level operation reports (decision 8): the operation's
// key, status and reason, its handle, the money truth learned so far —
// committed principal, whether the destination credit is confirmed, fee
// charged/returned, principal returned — plus child operations whose
// effects remain unresolved, so callers never schedule deferred work
// themselves.
                                  
              
                          
                  
                                                                    
                                                                   
                     
                                                                      
                         
                                                                           
                                                                    
                                       
                          
                           
                                 
                                                                          
                                
                             
                                                                   
                                                              
                                
 

// The reserve outcome adds the acceptance and hold references and the
// hold's expiry (decision 8), plus the group handle for group members.
                                                         
                         
                   
                     
                              
 

// The stages a provider-level fault can name (decision 12): the actual
// operations the provider runs — ledger stages forwarded to the digital-euro
// ledger or the interbank module under the same child key, plus the
// provider-internal bookkeeping stages: the linked-bank debit during
// funding ('bank_debit') and the bank credit restoring funded or returned
// money ('bank_restore'). 'hold' and 'release' also name the bank rail's
// internal hold bookkeeping under its own child keys. Return bookkeeping
// is not a keyed child stage and names no faultable stage.
                           
                    
                     
                
                   

// ---------------------------------------------------------------------------
// Orchestrator-level records (decisions 6–8; spec §4.5, §6, §7, §7.1). The
// intent is the frozen admission; the snapshot is the detached projection
// the coordinator derives purchase state and budget effects from. Neither
// carries a mutable Map, a module instance or a callback.

// 'atomic' reserves every leg before any commit and compensates committed
// payments on conclusive failure — reserve-all with compensation across
// ledgers, never cross-ledger atomicity (decision 3). 'independent'
// reserves and commits each leg separately, cleans up failed legs, keeps
// successful ones and relies on the explicit recovery path. The mode is
// the signed `SettlementMode` from core terms.

// Budgets the coordinator admitted synchronously before the first handoff:
// the employer's benefit draw and the employee's monthly automatic booking.
// Metadata only — the coordinator owns consume/release decisions from
// snapshot evidence; the orchestrator never touches these budgets.
                                  
                                                       
                                                                                        
                                                                          
                                                                            
                                                                 
                                                           
 

// The frozen submission (decision 8): the admitted purchase identity,
// the signed mode, the ordered legs and the admitted budget metadata.
// purchaseRef is the identity reconcile() and returnSettled() key on;
// every leg must agree with the intent's purchaseId and proposalVersion.
// A replay under the same purchaseRef with canonically different terms is
// a conclusive refusal.
                                   
                      
                     
                          
                       
                        
                            
 

// Why a settled leg is being returned (decision 6): 'compensation' is the
// automatic undo of a cross-ledger purchase and returns principal plus any
// charged fee; 'recovery', 'refund' and 'dispute' are ordinary returns and
// preserve the principal-only fee policy (decision 9).
                                                                              

// Which frozen legs a return targets and why. legs names leg roles — roles
// are unique per proposal, and the purchaseRef binds the version — so a
// role is a complete frozen leg identity inside the intent. Public callers
// never supply this directly (decision 6).
                              
                       
                          
 

// Settlement progress, reported separately from the purchase lifecycle
// (spec §7.1). 'reserving'/'reserved'/'committing' are forward progress;
// 'unwinding' releases holds and restores funding after a conclusive
// refusal with no committed payment; 'compensating' returns confirmed
// payments; 'settled' means every leg confirmed settled — payment
// committed AND destination credit complete; 'failed' means no payment
// committed and all holds/funding effects cleaned up; 'compensated'
// means automatic compensation and all cleanup confirmed including
// charged fees; 'recovered' means explicit recovery resolved every
// committed leg's principal with any retained fee still visible;
// 'recovery_required' means incomplete payment with confirmed committed
// principal, fee or recovery exposure that no current operation resolves.
                             
               
              
                
               
                  
             
            
                 
               
                        

// A detached view of one keyed settlement operation as the orchestrator
// last observed it — key, status, reason and the provider's reference.
                                          
              
                          
                  
                     
 

// One frozen leg's settlement projection: its recorded operations, hold
// lifecycle, the money truth learned so far and whether the payment is
// committed versus confirmed settled at the destination (decision 8).
                                        
                     
                          
               
                  
                  
             
                        
                  
                           
                                                                    
                                                                   
                                    
                                   
                                    
                                     
                                                                      
                                                                        
                   
                                                                     
                         
                                                                         
                                                                         
                                      
                                                               
                   
                          
                           
                                 
                            
 

// The frozen digital-euro group's projection: the original group key, its
// operation status and each member's commit outcome (decisions 8, 11).
                                          
              
                          
                  
            
                
                    
                     
                            
                    
      
 

// The detached settlement evidence the coordinator consumes (decision 8):
// phase, ordered leg outcomes, hold lifecycle, operation status and
// references, principal/fee returned, unresolved operations, cleanup
// confirmation, retained fees and known exposure — confirmed committed
// principal or charged fees that no confirmed return has restored.
                                     
                      
                     
                          
                       
                         
                                
                                  
                                            
                        
                      
                                
                          
                                                                       
                                                                      
                          
                       
                                                                       
                                
                                                                          
                                    
                            
 
