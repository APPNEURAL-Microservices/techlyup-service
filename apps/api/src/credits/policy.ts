/** Product policy only. No auth, balance, reservation, payment or payout effects. */
export const SUPPORT_CREDIT_POLICY_VERSION = '2026-10-20.v1' as const;
export const SUPPORT_CREDIT_ASSET = 'TECHLYUP_SUPPORT_CREDIT' as const;
export const INR_PAISE_PER_SUPPORT_CREDIT = 100 as const;

export type CreditPolicyErrorCode =
  | 'INVALID_CREDIT_UNITS'
  | 'CREDIT_VALUE_OVERFLOW'
  | 'CREDIT_ALLOCATION_NOT_EXACT'
  | 'SUPPORT_AMOUNT_OUT_OF_RANGE'
  | 'QUESTION_BID_OUT_OF_RANGE'
  | 'QUESTION_BID_DECREASE';

export class CreditPolicyError extends RangeError {
  constructor(public readonly code: CreditPolicyErrorCode) {
    super(code);
    this.name = 'CreditPolicyError';
  }
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function wholeUnits(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) throw new CreditPolicyError('INVALID_CREDIT_UNITS');
  return value;
}

function safeNumber(value: bigint): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new CreditPolicyError('CREDIT_VALUE_OVERFLOW');
  }
  return Number(value);
}

/** A valuation, never a charge or a grant. Zero has zero value. */
export function creditValueInPaise(creditUnits: unknown): number {
  return safeNumber(BigInt(wholeUnits(creditUnits)) * BigInt(INR_PAISE_PER_SUPPORT_CREDIT));
}

export interface SupportCreditPack {
  readonly id: string;
  readonly policyVersion: typeof SUPPORT_CREDIT_POLICY_VERSION;
  readonly asset: typeof SUPPORT_CREDIT_ASSET;
  readonly creditUnits: number;
  readonly priceCurrency: 'INR';
  readonly pricePaise: number;
}

export const SUPPORT_CREDIT_CATALOG: readonly SupportCreditPack[] = Object.freeze(
  [100, 250, 500, 1000].map((creditUnits) => Object.freeze({
    id: `support-credits-${creditUnits}`,
    policyVersion: SUPPORT_CREDIT_POLICY_VERSION,
    asset: SUPPORT_CREDIT_ASSET,
    creditUnits,
    priceCurrency: 'INR' as const,
    pricePaise: creditValueInPaise(creditUnits),
  })),
);

export const SUPPORT_CREDIT_POLICY = Object.freeze({
  version: SUPPORT_CREDIT_POLICY_VERSION,
  asset: SUPPORT_CREDIT_ASSET,
  unit: 'CREDIT' as const,
  priceCurrency: 'INR' as const,
  paisePerCredit: INR_PAISE_PER_SUPPORT_CREDIT,
  purchasedCreditsExpire: false,
  support: Object.freeze({
    presets: Object.freeze([25, 50, 100] as const),
    minimumCredits: 1,
    maximumCredits: 1000,
  }),
  questionBid: Object.freeze({
    minimumCredits: 1,
    maximumCredits: 500,
    increasesOnly: true,
    reserveOnBid: true,
    captureOn: 'HOST_ANSWERED' as const,
    captureAuthority: 'SESSION_MANAGER' as const,
    releaseUnanswered: true,
    // Descriptive contract; the current Q&A routes do not enforce this yet.
    priorityOrder: Object.freeze([
      'CONFIRMED_RESERVED_CREDITS_DESC', 'PINNED_DESC', 'FREE_VOTES_DESC',
      'QUESTION_CREATED_AT_ASC', 'QUESTION_ID_ASC',
    ] as const),
  }),
  grossConsumedValueAllocation: Object.freeze({
    mentorBasisPoints: 9000,
    platformBasisPoints: 1000,
    actualPayoutOrSettlement: false,
  }),
});

export function validateSupportCredits(value: unknown): number {
  const units = wholeUnits(value);
  if (
    units < SUPPORT_CREDIT_POLICY.support.minimumCredits ||
    units > SUPPORT_CREDIT_POLICY.support.maximumCredits
  ) throw new CreditPolicyError('SUPPORT_AMOUNT_OUT_OF_RANGE');
  return units;
}

/**
 * Compare absolute desired bids. Repeating the current amount is a zero delta;
 * this is not a lock, an idempotency store or a balance/ownership check.
 */
export function questionBidIncrease(currentCredits: unknown, desiredCredits: unknown) {
  const previous = wholeUnits(currentCredits);
  const desired = wholeUnits(desiredCredits);
  const maximum = SUPPORT_CREDIT_POLICY.questionBid.maximumCredits;
  if (previous > maximum || desired < 1 || desired > maximum) {
    throw new CreditPolicyError('QUESTION_BID_OUT_OF_RANGE');
  }
  if (desired < previous) throw new CreditPolicyError('QUESTION_BID_DECREASE');
  return Object.freeze({
    previousCredits: previous,
    desiredCredits: desired,
    deltaCredits: desired - previous,
  });
}

/**
 * Attribute gross consumed credit value; do not transfer funds. With 100 paise
 * per whole credit, both 90/10 shares are exact, so there is no rounding loss.
 */
export function splitConsumedCreditValue(creditUnits: unknown) {
  const units = wholeUnits(creditUnits);
  const grossValuePaise = creditValueInPaise(units);
  const allocation = SUPPORT_CREDIT_POLICY.grossConsumedValueAllocation;
  const mentorBasisPoints = BigInt(allocation.mentorBasisPoints);
  const platformBasisPoints = BigInt(allocation.platformBasisPoints);
  const basisPointScale = 10000n;
  const gross = BigInt(grossValuePaise);
  if (
    mentorBasisPoints + platformBasisPoints !== basisPointScale ||
    gross * mentorBasisPoints % basisPointScale !== 0n ||
    gross * platformBasisPoints % basisPointScale !== 0n
  ) throw new CreditPolicyError('CREDIT_ALLOCATION_NOT_EXACT');
  const mentorValuePaise = safeNumber(gross * mentorBasisPoints / basisPointScale);
  const platformValuePaise = safeNumber(gross * platformBasisPoints / basisPointScale);
  return Object.freeze({
    policyVersion: SUPPORT_CREDIT_POLICY_VERSION,
    asset: SUPPORT_CREDIT_ASSET,
    creditUnits: units,
    currency: 'INR' as const,
    grossValuePaise,
    mentorValuePaise,
    platformValuePaise,
    actualPayoutOrSettlement: false as const,
  });
}
