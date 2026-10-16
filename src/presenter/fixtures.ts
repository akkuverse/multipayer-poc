// Synthetic presenter catalog and the deterministic script inputs. Every
// offer is merchant-sourced data, immutable within a run: changed terms need
// a new offer reference, never a reprice in place. Merchants reuse the
// existing synthetic world accounts — there is no payeeId because merchant
// and payee are identical here.
//
// The script matches docs/experiment-protocol.md: vegetarian lunch within ten
// minutes, at most EUR 8 personally, employer benefit if available. Offer A
// (EUR 13) expires mid-run; B is the EUR 14 replacement that would put EUR 9
// on the employee — above the fixed instruction; C is the EUR 13 alternative.

import { EMPLOYEE, MERCHANT_A, MERCHANT_B, MERCHANT_C } from './scenarios.ts';
import type { CatalogOffer } from './presenter-session.ts';

// Bump whenever a fixture below changes, so recorded runs say which catalog
// and script produced them.
export const PRESENTER_FIXTURE_VERSION = '2026.10-1';

// The world clock starts at t=10. A's window ends at 60, so a script that
// approves early and resumes at t=70 finds A expired.
export const OFFER_A: CatalogOffer = {
  offerRef: 'offer-a',
  merchantId: MERCHANT_A,
  title: 'Vegetarian lunch bowl',
  tags: ['lunch', 'vegetarian'],
  priceCents: 1_300,
  availability: { from: 0, until: 60 },
  source: 'merchant-a-menu-feed',
  walkingMinutes: 5,
};

// The replacement shown after A expires. EUR 14 leaves EUR 9 on the employee:
// outside the EUR 8 instruction, so it stays a draft.
export const OFFER_B: CatalogOffer = {
  offerRef: 'offer-b',
  merchantId: MERCHANT_B,
  title: 'Vegetarian lunch plate',
  tags: ['lunch', 'vegetarian'],
  priceCents: 1_400,
  availability: { from: 0, until: 600 },
  source: 'merchant-b-menu-feed',
  walkingMinutes: 8,
};

// The eligible alternative the script chooses.
export const OFFER_C: CatalogOffer = {
  offerRef: 'offer-c',
  merchantId: MERCHANT_C,
  title: 'Vegetarian soup and salad',
  tags: ['lunch', 'vegetarian'],
  priceCents: 1_300,
  availability: { from: 0, until: 600 },
  source: 'merchant-c-menu-feed',
  walkingMinutes: 9,
};

// Decoy: cheapest and closest, but not vegetarian — the tag filter drops it.
export const OFFER_MEAT: CatalogOffer = {
  offerRef: 'offer-meat',
  merchantId: MERCHANT_A,
  title: 'Chicken schnitzel lunch',
  tags: ['lunch'],
  priceCents: 1_100,
  availability: { from: 0, until: 600 },
  source: 'merchant-a-menu-feed',
  walkingMinutes: 4,
};

// Decoy: vegetarian and cheaper than A, but too far away — the walking filter
// drops it.
export const OFFER_FAR: CatalogOffer = {
  offerRef: 'offer-far',
  merchantId: MERCHANT_B,
  title: 'Vegetarian lunch across town',
  tags: ['lunch', 'vegetarian'],
  priceCents: 1_200,
  availability: { from: 0, until: 600 },
  source: 'merchant-b-menu-feed',
  walkingMinutes: 25,
};

// Deliberately unsorted: discovery must order by price then reference itself.
export const PRESENTER_CATALOG: readonly CatalogOffer[] = [OFFER_C, OFFER_FAR, OFFER_MEAT, OFFER_B, OFFER_A];

// The deterministic inputs the scripted presenter feeds the session.
export const PRESENTER_SCRIPT = {
  sessionId: 'session-1',
  purchaseId: 'purchase-1',
  agentId: 'agent-1',
  employeeId: EMPLOYEE,
  // "At most EUR 8 personally" — fee included — under the standard mandate.
  employeeMaxCents: 800,
  employeeFeeCents: 0,
  mandateRef: 'mandate-1',
  grantRef: 'grant-1',
  grantExpiresAt: 1_000,
  // "Vegetarian lunch within ten minutes."
  preferences: { tags: ['vegetarian'], maxWalkingMinutes: 10 },
  // The run starts at the world's t=10; the script resumes after A's window
  // ends, at t=70.
  resumeAt: 70,
} as const;
