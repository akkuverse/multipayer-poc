// GENERATED from src/core/signing.ts — type-stripped build artifact; never hand-edit.
// Signed authority objects. Ed25519 via node:crypto over canonical JSON, the
// same idea as AP2's signed mandates without the SD-JWT format. Synthetic
// fixtures derive keys from fixed seeds so traces stay reproducible.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from '../../shims/node-crypto.js';
                                             
                                                       

// PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

                          
                
                        
                       
 

export function keyPairFromSeed(keyId        , seed        )          {
  const raw = createHash('sha256').update(seed).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: 'der', type: 'pkcs8' });
  return { keyId, privateKey, publicKey: createPublicKey(privateKey) };
}

// JSON with object keys sorted at every level and undefined fields dropped,
// so the same payload always produces the same bytes. Payloads are JSON-typed
// values (strings, numbers, booleans, arrays, plain objects); anything else —
// undefined roots, functions, NaN — is outside the signed domain.
export function canonicalJson(value         )         {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value                           ;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

                            
             
                
                                                             
                    
 

// Public keys the coordinator trusts, each bound to the party that holds it.
                                                                                        

export function signPayload   (payload   , key         )            {
  const signature = sign(null, Buffer.from(canonicalJson(payload)), key.privateKey).toString('base64url');
  // A copy, so later edits to the caller's object cannot alter what was signed.
  return { payload: structuredClone(payload), keyId: key.keyId, signature };
}

// True only if the key is registered to `holder` and the signature matches.
export function verifyPayload   (s           , keys             , holder        )          {
  const k = keys.get(s.keyId);
  if (!k || k.holder !== holder) return false;
  return verify(null, Buffer.from(canonicalJson(s.payload)), k.publicKey, Buffer.from(s.signature, 'base64url'));
}

// The complete-share binding a PayerApproval carries: SHA-256 hex over the
// canonical ordered shares, so the approval names role, payer, payee, rail,
// principal, fee and authority — not just the payer totals. The
// coordinator's privacy/signing ownership computes it from the retained
// ordered shares and projects it onto the approval terms a device
// countersigns — the device signs the coordinator's commitment to the
// allocation, it does not (and under mutual anonymity cannot)
// independently reconstruct every hidden share. Verification recomputes
// the same value from the retained shares, so a changed rail, payee or
// fee can never pass under a digest meant for other terms. The digest is
// unsalted and deterministic: a binding, not an anonymity guarantee —
// fixtures keep donor identifiers opaque so it cannot trivialize to a
// lookup (spec §3.3 caveat).
export function sharesDigestOf(shares                  )         {
  return createHash('sha256').update(canonicalJson(shares)).digest('hex');
}

// The campaign commitment a pledge signature binds: SHA-256 over the
// canonical campaign table — every signed term the open_fund request
// fixed, tagged by its own kind so the digest domain can never collide
// with an approval's share digest or another signed record.
// Every campaign-table field is selected explicitly: an OpenFundRequest
// passed in carries envelope metadata (kind, by, proposalVersion) that is
// never part of the terms, so it must not reach the hash; and omitted
// signed terms are never filled with defaults here.
export function campaignDigestOf(terms               )         {
  const campaignTerms                = {
    purchaseId: terms.purchaseId,
    payeeId: terms.payeeId,
    condition: terms.condition,
    fundingEndsAt: terms.fundingEndsAt,
    settleBy: terms.settleBy,
    acceptPledgesUntil: terms.acceptPledgesUntil,
    submitPolicy: terms.submitPolicy,
    settlementMode: terms.settlementMode,
    privacyProfile: terms.privacyProfile,
  };
  return createHash('sha256')
    .update(canonicalJson({ kind: 'fund_campaign_v1', terms: campaignTerms }))
    .digest('hex');
}
