// Offline tests for the v7 subscription dates (api/v7/account/_subscription.js):
// monthly charge dates, the end of service after a cancellation, and status.
//   node --test scripts/test-subscription-dates.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonthsIso, nextChargeDate, ilMidnightIso, lastServiceDay, subscriptionStatus,
} from '../api/v7/account/_subscription.js';

test('addMonthsIso clamps to the month\'s last day, from the original day each time', () => {
  assert.equal(addMonthsIso('2026-10-05', 1), '2026-11-05');
  assert.equal(addMonthsIso('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonthsIso('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsIso('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonthsIso('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonthsIso('2026-11-30', 3), '2027-02-28');
  assert.equal(addMonthsIso('2026-10-05', 15), '2028-01-05');
});

test('nextChargeDate is the first monthly date after today (Israel)', () => {
  const paid = '2026-10-05T10:00:00Z';
  assert.equal(nextChargeDate(paid, new Date('2026-10-05T12:00:00Z')), '2026-11-05');
  assert.equal(nextChargeDate(paid, new Date('2026-10-20T10:00:00Z')), '2026-11-05');
  // 23:30 in Israel on Nov 4 — still before the charge day.
  assert.equal(nextChargeDate(paid, new Date('2026-11-04T21:30:00Z')), '2026-11-05');
  // On the charge day itself the month is counted as charged.
  assert.equal(nextChargeDate(paid, new Date('2026-11-05T06:00:00Z')), '2026-12-05');
  assert.equal(nextChargeDate(paid, new Date('2027-03-10T10:00:00Z')), '2027-04-05');
});

test('the first payment\'s day is its Israel date', () => {
  // 22:30 UTC on Oct 5 = 01:30 on Oct 6 in Israel.
  assert.equal(nextChargeDate('2026-10-05T22:30:00Z', new Date('2026-10-20T10:00:00Z')), '2026-11-06');
});

test('ilMidnightIso / lastServiceDay', () => {
  assert.equal(ilMidnightIso('2026-11-05'), '2026-11-04T22:00:00.000Z');   // winter, UTC+2
  assert.equal(ilMidnightIso('2026-07-05'), '2026-07-04T21:00:00.000Z');   // summer, UTC+3
  assert.equal(lastServiceDay(ilMidnightIso('2026-11-05')), '2026-11-04');
  assert.equal(lastServiceDay(ilMidnightIso('2027-01-01')), '2026-12-31');
});

test('subscriptionStatus', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  assert.equal(subscriptionStatus(null, now), 'active');
  assert.equal(subscriptionStatus({ subscription_cancelled_at: null }, now), 'active');
  assert.equal(subscriptionStatus({
    subscription_cancelled_at: '2026-10-19T10:00:00Z', subscription_ends_at: '2026-11-04T22:00:00Z',
  }, now), 'cancelled');
  assert.equal(subscriptionStatus({
    subscription_cancelled_at: '2026-10-19T10:00:00Z', subscription_ends_at: '2026-10-20T09:00:00Z',
  }, now), 'ended');
});
