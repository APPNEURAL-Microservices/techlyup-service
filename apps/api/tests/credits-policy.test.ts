import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CreditPolicyError,
  type CreditPolicyErrorCode,
  SUPPORT_CREDIT_ASSET,
  SUPPORT_CREDIT_CATALOG,
  SUPPORT_CREDIT_POLICY,
  SUPPORT_CREDIT_POLICY_VERSION,
  creditValueInPaise,
  questionBidIncrease,
  splitConsumedCreditValue,
  validateSupportCredits,
} from '../src/credits/policy';

function rejects(work: () => unknown, code: CreditPolicyErrorCode) {
  assert.throws(work, (error: unknown) => error instanceof CreditPolicyError && error.code === code);
}

const invalidWholeUnits: unknown[] = [
  -1, -0, 0.1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
  '25', 25n, null, undefined, true, {}, [],
];

test('versioned catalog prices credit packs in exact INR paise and cannot be mutated', () => {
  assert.deepEqual(SUPPORT_CREDIT_CATALOG.map((pack) => [pack.creditUnits, pack.pricePaise]), [
    [100, 10000], [250, 25000], [500, 50000], [1000, 100000],
  ]);
  assert.equal(new Set(SUPPORT_CREDIT_CATALOG.map((pack) => pack.id)).size, 4);
  for (const pack of SUPPORT_CREDIT_CATALOG) {
    assert.equal(pack.policyVersion, SUPPORT_CREDIT_POLICY_VERSION);
    assert.equal(pack.asset, SUPPORT_CREDIT_ASSET);
    assert.equal(pack.priceCurrency, 'INR');
    assert.equal(pack.pricePaise, creditValueInPaise(pack.creditUnits));
    assert.equal(Reflect.set(pack, 'pricePaise', 1), false);
  }
  assert.equal(Reflect.set(SUPPORT_CREDIT_CATALOG, '0', {}), false);
  assert.equal(Reflect.set(SUPPORT_CREDIT_POLICY.support.presets, '0', 999), false);
  assert.equal(Reflect.set(SUPPORT_CREDIT_POLICY.questionBid, 'maximumCredits', 999), false);
  assert.equal(SUPPORT_CREDIT_POLICY.purchasedCreditsExpire, false);
  assert.notEqual(SUPPORT_CREDIT_POLICY.asset, SUPPORT_CREDIT_POLICY.priceCurrency);
});

test('support accepts presets and custom whole credits only within the product limits', () => {
  for (const units of [1, 25, 50, 100, 999, 1000]) {
    assert.equal(validateSupportCredits(units), units);
  }
  for (const units of [0, 1001, Number.MAX_SAFE_INTEGER]) {
    rejects(() => validateSupportCredits(units), 'SUPPORT_AMOUNT_OUT_OF_RANGE');
  }
  for (const units of invalidWholeUnits) {
    rejects(() => validateSupportCredits(units), 'INVALID_CREDIT_UNITS');
  }
});

test('credit valuation checks integer safety before exact multiplication and rejects overflow', () => {
  assert.equal(creditValueInPaise(0), 0);
  assert.equal(creditValueInPaise(1), 100);
  assert.equal(creditValueInPaise(1000), 100000);
  const largest = Math.floor(Number.MAX_SAFE_INTEGER / 100);
  const expected = Number(BigInt(largest) * 100n);
  assert.equal(creditValueInPaise(largest), expected);
  assert.equal(Number.isSafeInteger(expected), true);
  rejects(() => creditValueInPaise(largest + 1), 'CREDIT_VALUE_OVERFLOW');
  rejects(() => creditValueInPaise(Number.MAX_SAFE_INTEGER), 'CREDIT_VALUE_OVERFLOW');
  for (const units of invalidWholeUnits) {
    rejects(() => creditValueInPaise(units), 'INVALID_CREDIT_UNITS');
  }
});

test('question bids calculate increase deltas and reject decreases or invalid prior state', () => {
  assert.deepEqual(questionBidIncrease(0, 1), { previousCredits: 0, desiredCredits: 1, deltaCredits: 1 });
  assert.equal(questionBidIncrease(1, 500).deltaCredits, 499);
  assert.equal(questionBidIncrease(499, 500).deltaCredits, 1);
  assert.equal(questionBidIncrease(500, 500).deltaCredits, 0);
  rejects(() => questionBidIncrease(100, 99), 'QUESTION_BID_DECREASE');
  for (const [current, desired] of [[0, 0], [0, 501], [501, 501], [501, 500]]) {
    rejects(() => questionBidIncrease(current, desired), 'QUESTION_BID_OUT_OF_RANGE');
  }
  for (const invalid of invalidWholeUnits) {
    rejects(() => questionBidIncrease(invalid, 25), 'INVALID_CREDIT_UNITS');
    rejects(() => questionBidIncrease(0, invalid), 'INVALID_CREDIT_UNITS');
  }
});

test('repeating an absolute bid yields zero delta after state advances, without claiming ledger idempotency', () => {
  const initial = questionBidIncrease(0, 120);
  const increased = questionBidIncrease(initial.desiredCredits, 200);
  const repeated = questionBidIncrease(increased.desiredCredits, 200);
  assert.equal(initial.deltaCredits, 120);
  assert.equal(increased.deltaCredits, 80);
  assert.equal(repeated.deltaCredits, 0);
  assert.equal(initial.deltaCredits + increased.deltaCredits + repeated.deltaCredits, 200);
  // A caller with stale state still computes a delta: the real ledger must lock
  // and verify revisions/idempotency independently of this pure calculation.
  assert.equal(questionBidIncrease(120, 200).deltaCredits, 80);
  assert.deepEqual(questionBidIncrease(120, 200), increased);
});

test('consumed value is conserved exactly at 90/10 without rounding, transfers or settlement claims', () => {
  const allocation = SUPPORT_CREDIT_POLICY.grossConsumedValueAllocation;
  assert.equal(allocation.mentorBasisPoints, 9000);
  assert.equal(allocation.platformBasisPoints, 1000);
  assert.equal(allocation.mentorBasisPoints + allocation.platformBasisPoints, 10000);
  for (let units = 0; units <= 1000; units += 1) {
    const result = splitConsumedCreditValue(units);
    assert.equal(result.grossValuePaise, units * 100);
    assert.equal(result.mentorValuePaise, units * 90);
    assert.equal(result.platformValuePaise, units * 10);
    assert.equal(BigInt(result.mentorValuePaise) * 10000n, BigInt(result.grossValuePaise) * BigInt(allocation.mentorBasisPoints));
    assert.equal(BigInt(result.platformValuePaise) * 10000n, BigInt(result.grossValuePaise) * BigInt(allocation.platformBasisPoints));
    assert.equal(result.mentorValuePaise + result.platformValuePaise, result.grossValuePaise);
    assert.equal(result.actualPayoutOrSettlement, false);
    assert.equal(result.asset, SUPPORT_CREDIT_ASSET);
    assert.equal(result.currency, 'INR');
  }
  const largest = Math.floor(Number.MAX_SAFE_INTEGER / 100);
  const boundary = splitConsumedCreditValue(largest);
  assert.equal(Number.isSafeInteger(boundary.mentorValuePaise), true);
  assert.equal(Number.isSafeInteger(boundary.platformValuePaise), true);
  assert.equal(boundary.mentorValuePaise + boundary.platformValuePaise, boundary.grossValuePaise);
  rejects(() => splitConsumedCreditValue(largest + 1), 'CREDIT_VALUE_OVERFLOW');
  for (const invalid of invalidWholeUnits) {
    rejects(() => splitConsumedCreditValue(invalid), 'INVALID_CREDIT_UNITS');
  }
});
