// GENERATED from src/core/policy.ts — type-stripped build artifact; never hand-edit.
// Deterministic benefit evaluation. No AI and no payment side effects: it only
// decides eligibility and amounts. Conditions live here, in the application,
// never in the money itself.

                                                         
                                              

                               
                    
                     
                                                               
                        
                           
                                                                          
              
                                                                          
                        
 

                                
                       
                       
                                                          
                            
 

// Why the mandate cannot fund this purchase right now, or undefined when it
// can. Checked both at proposal time and again at initiation.
export function mandateProblem(m                 , merchantId        , beneficiaryId        , now        )                     {
  if (m.revoked) return 'mandate_revoked';
  if (now < m.validFrom || now > m.validUntil) return 'mandate_expired';
  if (m.beneficiaryRef !== beneficiaryId) return 'beneficiary_mismatch';
  if (!m.eligibleMerchants.includes(merchantId)) return 'merchant_not_eligible';
  return undefined;
}

// Equal split in integer cents. The remainder goes one cent at a time to the
// first payers in the order given, so the split is deterministic and sums
// exactly to the total.
export function equalShares(totalCents       , n        )          {
  if (!Number.isInteger(totalCents) || !Number.isInteger(n) || n <= 0) {
    throw new Error('equalShares needs integer cents and a positive integer count');
  }
  const base = Math.floor(totalCents / n);
  const rest = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

export function evaluateBenefit(input              )                {
  const problem = mandateProblem(input.mandate, input.merchantId, input.beneficiaryId, input.now);
  // A missing or malformed daily purchase limit fails closed, as if the
  // mandate allowed no subsidised purchases at all.
  const maxPurchases = Number.isInteger(input.mandate.maxPurchasesPerDay) ? input.mandate.maxPurchasesPerDay : 0;
  const limitReached = input.usedToday.purchases >= maxPurchases;
  const remainingToday = Math.max(0, input.mandate.maxPerDayCents - input.usedToday.cents);
  // The employer share is the tightest of the per-purchase cap, the remaining
  // daily budget and the purchase total. A mandate problem or a used-up daily
  // purchase zeroes it rather than falling back to a partial contribution.
  const employerCents =
    problem || limitReached ? 0 : Math.min(input.mandate.maxPerPurchaseCents, remainingToday, input.totalCents);
  // The employee always covers the remainder; nothing about the employer's
  // answer changes the total owed.
  const employeeCents = input.totalCents - employerCents;
  return {
    employerCents,
    employeeCents,
    ineligibleReason:
      problem ?? (limitReached ? 'daily_purchase_limit_reached' : employerCents === 0 ? 'daily_cap_used' : undefined),
  };
}
