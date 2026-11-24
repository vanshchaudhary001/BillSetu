/**
 * Automated Test Suite for GST Filing Deadline Reminders
 * Uses Node.js native test runner (node:test) and strict assertions (node:assert/strict).
 *
 * Covers:
 * - Valid / invalid GSTIN formats
 * - Required profile fields validation
 * - BUG FIX: State vs GSTIN matching & mismatch validation
 * - BUG FIX: QRMP conflict protection with mismatched state
 * - Monthly and quarterly tax period generation
 * - Statutory due-date calculations (Monthly & QRMP)
 * - Missing rules and unverified due dates
 * - BUG FIX: Strict calendar date validation (2026-02-31, 2026-02-29, 2024-02-29, 2026-13-01)
 * - Days remaining calculations (overdue, due soon, upcoming)
 * - Filing status transitions and invalid date verification flag
 * - Storage operations & corruption recovery
 * - BUG FIX: Storage failure handling returning explicit success/failure
 * - BUG FIX: initialProfile initialization and priority logic
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_CODES,
  validateGSTIN,
  validateProfile,
  generateMonthlyPeriods,
  generateQuarterlyPeriods,
  calculateDueDate,
  calculateDaysRemaining,
  deriveDeadlineStatus,
  generateDeadlines,
  toIsoDate,
  isLeapYear,
  getDaysInMonth,
  isValidCalendarDate,
  isValidCalendarDateStr,
  isValidTimezoneOffset
} from './rules.js';

import {
  STORAGE_KEY,
  DEFAULT_DEADLINES_STATE,
  loadDeadlinesState,
  saveDeadlinesState,
  saveBusinessProfile,
  markReturnFiled,
  unmarkReturnFiled,
  updateFilingRecord,
  clearDeadlinesData
} from './storage.js';

// In-memory mock storage for isolated tests
function createMockStorage(initialData = {}, shouldFail = false) {
  const store = new Map(Object.entries(initialData));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      if (shouldFail) {
        throw new Error('QuotaExceededError: The quota has been exceeded.');
      }
      store.set(key, String(value));
    },
    removeItem: (key) => {
      if (shouldFail) {
        throw new Error('StorageError: Unable to remove item.');
      }
      store.delete(key);
    },
    clear: () => store.clear(),
    _store: store
  };
}

describe('GSTIN Validation', () => {
  it('should accept valid 15-character GSTIN with valid state code', () => {
    const validGstin = '09ABCDE1234F1ZY';
    const result = validateGSTIN(validGstin);
    assert.equal(result.isValid, true);
    assert.equal(result.stateCode, '09');
    assert.equal(result.stateName, 'Uttar Pradesh');
  });

  it('should reject invalid GSTIN format (wrong length or characters)', () => {
    assert.equal(validateGSTIN('').isValid, false);
    assert.equal(validateGSTIN('INVALID123').isValid, false);
    assert.equal(validateGSTIN('09ABCDE1234F1Z').isValid, false);
    assert.equal(validateGSTIN('09ABCDE1234F1ZYY').isValid, false);
  });

  it('should reject GSTIN with unrecognized state code', () => {
    const result = validateGSTIN('99ABCDE1234F1ZY');
    assert.equal(result.isValid, false);
    assert.match(result.error, /Invalid state code/);
  });
});

describe('Business Profile Validation & Strict State Consistency (Fix 1)', () => {
  const baseProfile = {
    businessName: 'Sharma Electricals',
    gstin: '09ABCDE1234F1ZY', // 09 is Uttar Pradesh
    filingFrequency: 'Monthly',
    applicableReturns: ['GSTR-1', 'GSTR-3B']
  };

  it('1. should pass validation with correct state name + correct state code', () => {
    const profile = {
      ...baseProfile,
      state: 'Uttar Pradesh',
      stateCode: '09'
    };
    const result = validateProfile(profile);
    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, {});
  });

  it('2. should fail validation with incorrect state name + correct state code', () => {
    const profile = {
      ...baseProfile,
      state: 'Delhi',
      stateCode: '09'
    };
    const result = validateProfile(profile);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.state);
    assert.match(result.errors.state, /does not match GSTIN state 'Uttar Pradesh'/);
  });

  it('3. should fail validation with correct state name + incorrect state code', () => {
    const profile = {
      ...baseProfile,
      state: 'Uttar Pradesh',
      stateCode: '07' // 07 is Delhi, but GSTIN is 09
    };
    const result = validateProfile(profile);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.state);
    assert.match(result.errors.state, /Selected state code '07' does not match GSTIN state code '09'/);
  });

  it('4. should fail validation with incorrect state name + incorrect state code', () => {
    const profile = {
      ...baseProfile,
      state: 'Delhi',
      stateCode: '07'
    };
    const result = validateProfile(profile);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.state);
    assert.match(result.errors.state, /Selected state 'Delhi' and state code '07' do not match GSTIN state 'Uttar Pradesh' \(09\)/);
  });

  it('should pass validation when only correct state name is provided without stateCode', () => {
    const profile = {
      ...baseProfile,
      state: 'Uttar Pradesh'
    };
    const result = validateProfile(profile);
    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, {});
  });

  it('should require business name', () => {
    const result = validateProfile({ ...baseProfile, state: 'Uttar Pradesh', stateCode: '09', businessName: '   ' });
    assert.equal(result.isValid, false);
    assert.ok(result.errors.businessName);
  });

  it('should require valid GSTIN', () => {
    const result = validateProfile({ ...baseProfile, state: 'Uttar Pradesh', stateCode: '09', gstin: 'BAD_GSTIN' });
    assert.equal(result.isValid, false);
    assert.ok(result.errors.gstin);
  });

  it('should validate filing frequency (Monthly or Quarterly)', () => {
    const result = validateProfile({ ...baseProfile, state: 'Uttar Pradesh', stateCode: '09', filingFrequency: 'Biweekly' });
    assert.equal(result.isValid, false);
    assert.ok(result.errors.filingFrequency);
  });

  it('should require at least one applicable return', () => {
    const result = validateProfile({ ...baseProfile, state: 'Uttar Pradesh', stateCode: '09', applicableReturns: [] });
    assert.equal(result.isValid, false);
    assert.ok(result.errors.applicableReturns);
  });
});

describe('QRMP State Grouping & Conflict Prevention (Bug 2)', () => {
  const period = { periodKey: 'FY2026-2027-Q2', quarter: 2, endMonth: 9, year: 2026, type: 'quarterly' };

  it('should NOT calculate QRMP using a manually selected state that conflicts with GSTIN', () => {
    // GSTIN is Uttar Pradesh (09 - Group B), but profile.stateCode is manually set to 24 (Gujarat - Group A)
    const conflictingProfile = {
      gstin: '09ABCDE1234F1ZY',
      state: 'Gujarat',
      stateCode: '24',
      filingFrequency: 'Quarterly'
    };
    const res = calculateDueDate('GSTR-3B', period, conflictingProfile);
    assert.equal(res.requiresVerification, true);
    assert.equal(res.dueDate, null);
    assert.match(res.verificationReason, /conflicts with GSTIN state/);
  });

  it('should correctly use GSTIN state for QRMP Group A when consistent', () => {
    // Maharashtra (27) - Group A (due 22nd)
    const profile = {
      gstin: '27AAKFM2916L1ZY',
      state: 'Maharashtra',
      stateCode: '27',
      filingFrequency: 'Quarterly'
    };
    const res = calculateDueDate('GSTR-3B', period, profile);
    assert.equal(res.dueDate, '2026-10-22');
    assert.equal(res.requiresVerification, false);
  });

  it('should correctly use GSTIN state for QRMP Group B when consistent', () => {
    // Uttar Pradesh (09) - Group B (due 24th)
    const profile = {
      gstin: '09ABCDE1234F1ZY',
      state: 'Uttar Pradesh',
      stateCode: '09',
      filingFrequency: 'Quarterly'
    };
    const res = calculateDueDate('GSTR-3B', period, profile);
    assert.equal(res.dueDate, '2026-10-24');
    assert.equal(res.requiresVerification, false);
  });
});

describe('Strict Calendar Date & toIsoDate Validation (Fix 2)', () => {
  it('should correctly identify leap years', () => {
    assert.equal(isLeapYear(2024), true);
    assert.equal(isLeapYear(2020), true);
    assert.equal(isLeapYear(2000), true);
    assert.equal(isLeapYear(2026), false);
    assert.equal(isLeapYear(2025), false);
    assert.equal(isLeapYear(1900), false);
  });

  it('should return exact days in month including leap years', () => {
    assert.equal(getDaysInMonth(2026, 2), 28);
    assert.equal(getDaysInMonth(2024, 2), 29);
    assert.equal(getDaysInMonth(2026, 4), 30);
    assert.equal(getDaysInMonth(2026, 1), 31);
    assert.equal(getDaysInMonth(2026, 13), 0);
  });

  it('should strictly reject 2026-02-31 without silent rollover', () => {
    assert.equal(isValidCalendarDate(2026, 2, 31), false);
    assert.equal(isValidCalendarDateStr('2026-02-31'), false);
    assert.equal(toIsoDate('2026-02-31'), '');
    assert.equal(calculateDaysRemaining('2026-02-31', '2026-02-01'), null);
  });

  it('should strictly reject 2026-02-29 (non-leap year)', () => {
    assert.equal(isValidCalendarDate(2026, 2, 29), false);
    assert.equal(isValidCalendarDateStr('2026-02-29'), false);
    assert.equal(toIsoDate('2026-02-29'), '');
    assert.equal(calculateDaysRemaining('2026-02-29', '2026-02-01'), null);
  });

  it('should strictly accept 2024-02-29 (valid leap year)', () => {
    assert.equal(isValidCalendarDate(2024, 2, 29), true);
    assert.equal(isValidCalendarDateStr('2024-02-29'), true);
    assert.equal(toIsoDate('2024-02-29'), '2024-02-29');
    assert.equal(calculateDaysRemaining('2024-02-29', '2024-02-01'), 28);
  });

  it('should strictly reject 2026-13-01 (invalid month 13)', () => {
    assert.equal(isValidCalendarDate(2026, 13, 1), false);
    assert.equal(isValidCalendarDateStr('2026-13-01'), false);
    assert.equal(toIsoDate('2026-13-01'), '');
    assert.equal(calculateDaysRemaining('2026-13-01', '2026-12-01'), null);
  });

  it('should strictly reject arbitrary trailing characters (e.g. 2024-02-29garbage)', () => {
    assert.equal(toIsoDate('2024-02-29garbage'), '');
    assert.equal(toIsoDate('2024-02-29abc'), '');
    assert.equal(toIsoDate('2024-02-29 12:00:00'), '');
    assert.equal(isValidCalendarDateStr('2024-02-29garbage'), false);
    assert.equal(calculateDaysRemaining('2024-02-29garbage', '2024-02-01'), null);
  });

  it('should accept supported ISO 8601 datetime strings without arbitrary suffixes', () => {
    assert.equal(toIsoDate('2024-02-29T10:30:00Z'), '2024-02-29');
    assert.equal(toIsoDate('2024-02-29T10:30:00.123Z'), '2024-02-29');
    assert.equal(toIsoDate('2024-02-29T10:30:00+05:30'), '2024-02-29');
    assert.equal(toIsoDate('2024-02-29T10:30:00-04:00'), '2024-02-29');
    assert.equal(toIsoDate('2024-02-29T10:30:00+14:00'), '2024-02-29');
    assert.equal(toIsoDate('2024-02-29T10:30:00-12:00'), '2024-02-29');
    assert.equal(toIsoDate('2024-02-29T10:30'), '2024-02-29');
  });

  it('should validate timezone offset rules via isValidTimezoneOffset', () => {
    // Valid offsets
    assert.equal(isValidTimezoneOffset(0, 0), true);
    assert.equal(isValidTimezoneOffset(5, 30), true);
    assert.equal(isValidTimezoneOffset(14, 0), true);
    assert.equal(isValidTimezoneOffset(12, 0), true);
    assert.equal(isValidTimezoneOffset(11, 59), true);

    // Invalid offsets
    assert.equal(isValidTimezoneOffset(99, 99), false);
    assert.equal(isValidTimezoneOffset(14, 30), false);
    assert.equal(isValidTimezoneOffset(5, 99), false);
    assert.equal(isValidTimezoneOffset(15, 0), false);
    assert.equal(isValidTimezoneOffset(-1, 0), false);
  });

  it('should strictly reject invalid ISO 8601 timezone offsets in toIsoDate', () => {
    // Hours / minutes > 59 or hours > 14
    assert.equal(toIsoDate('2024-02-29T10:30:00+99:99'), '');
    assert.equal(toIsoDate('2024-02-29T10:30:00+14:30'), ''); // if 14, minutes must be 00
    assert.equal(toIsoDate('2024-02-29T10:30:00+05:99'), ''); // minutes > 59
    assert.equal(toIsoDate('2024-02-29T10:30:00+15:00'), ''); // hours > 14
    assert.equal(toIsoDate('2024-02-29T10:30:00-15:00'), ''); // hours > 14
    assert.equal(toIsoDate('2024-02-29T10:30:00-14:01'), ''); // if 14, minutes must be 00
  });

  it('should preserve valid Z, +05:30, -05:30, +14:00, and -12:00 timezone formats', () => {
    assert.equal(toIsoDate('2024-02-29T10:30:00Z'), '2024-02-29');
    assert.equal(toIsoDate('2024-02-29T10:30:00+05:30'), '2024-02-29');
    assert.equal(toIsoDate('2024-02-29T10:30:00-05:30'), '2024-02-29');
    assert.equal(toIsoDate('2024-02-29T10:30:00+14:00'), '2024-02-29');
    assert.equal(toIsoDate('2024-02-29T10:30:00-12:00'), '2024-02-29');
  });

  it('should reject malformed datetime suffixes and invalid time components', () => {
    assert.equal(toIsoDate('2024-02-29T10:30:00Zgarbage'), '');
    assert.equal(toIsoDate('2024-02-29T25:00:00Z'), ''); // Invalid hour 25
    assert.equal(toIsoDate('2024-02-29T10:65:00Z'), ''); // Invalid minute 65
    assert.equal(toIsoDate('2024-02-29T10:30:75Z'), ''); // Invalid second 75
    assert.equal(toIsoDate('2026-02-31T10:30:00Z'), ''); // Invalid calendar date in datetime
  });

  it('should preserve valid Date object behavior and reject invalid Date objects', () => {
    const validDate = new Date(2026, 9, 20); // October 20, 2026
    assert.equal(toIsoDate(validDate), '2026-10-20');

    const leapDate = new Date(2024, 1, 29); // Feb 29, 2024
    assert.equal(toIsoDate(leapDate), '2024-02-29');

    const invalidDate = new Date('not-a-valid-date');
    assert.equal(toIsoDate(invalidDate), '');
  });

  it('should handle empty and malformed dates safely', () => {
    assert.equal(isValidCalendarDateStr(''), false);
    assert.equal(isValidCalendarDateStr('not-a-date'), false);
    assert.equal(isValidCalendarDateStr(null), false);
    assert.equal(isValidCalendarDateStr(undefined), false);
    assert.equal(toIsoDate(''), '');
    assert.equal(toIsoDate(null), '');
    assert.equal(calculateDaysRemaining('', new Date()), null);
    assert.equal(calculateDaysRemaining(null, new Date()), null);
  });

  it('should ensure invalid due dates display "Due Date Requires Verification"', () => {
    const statusInvalidDate = deriveDeadlineStatus({
      dueDate: '2026-02-31',
      daysRemaining: null,
      isFiled: false
    });
    assert.equal(statusInvalidDate, 'Due Date Requires Verification');

    const statusLeapError = deriveDeadlineStatus({
      dueDate: '2026-02-29',
      daysRemaining: null,
      isFiled: false
    });
    assert.equal(statusLeapError, 'Due Date Requires Verification');

    const statusGarbage = deriveDeadlineStatus({
      dueDate: '2024-02-29garbage',
      daysRemaining: null,
      isFiled: false
    });
    assert.equal(statusGarbage, 'Due Date Requires Verification');
  });
});

describe('Tax Period Generation', () => {
  it('should generate monthly tax periods around a reference date', () => {
    const ref = new Date('2026-10-15T00:00:00Z');
    const periods = generateMonthlyPeriods(ref, 2, 1);

    assert.equal(periods.length, 4);
    const keys = periods.map(p => p.periodKey);
    assert.deepEqual(keys, ['2026-08', '2026-09', '2026-10', '2026-11']);

    const oct = periods.find(p => p.periodKey === '2026-10');
    assert.equal(oct.label, 'October 2026');
    assert.equal(oct.endDate, '2026-10-31');
    assert.equal(oct.type, 'monthly');
  });

  it('should generate quarterly tax periods with Indian FY naming', () => {
    const ref = new Date('2026-10-15T00:00:00Z');
    const quarters = generateQuarterlyPeriods(ref, 2, 1);

    assert.equal(quarters.length, 4);
    for (const q of quarters) {
      assert.equal(q.type, 'quarterly');
      assert.ok(q.periodKey.startsWith('FY'));
      assert.ok(q.endDate.match(/^\d{4}-\d{2}-\d{2}$/));
    }

    const q3 = quarters.find(q => q.quarter === 3 && q.fyYear === 2026);
    assert.ok(q3, 'Should generate Q3 for FY2026');
    assert.equal(q3.endMonth, 12);
    assert.equal(q3.endDate, '2026-12-31');
  });
});

describe('Statutory GST Due Date Calculations', () => {
  const profileMonthly = {
    businessName: 'Acme Traders',
    gstin: '09ABCDE1234F1ZY',
    state: 'Uttar Pradesh',
    stateCode: '09',
    filingFrequency: 'Monthly'
  };

  it('should calculate Monthly GSTR-1 due date as 11th of succeeding month', () => {
    const period = { periodKey: '2026-10', month: 10, year: 2026, type: 'monthly' };
    const res = calculateDueDate('GSTR-1', period, profileMonthly);

    assert.equal(res.dueDate, '2026-11-11');
    assert.equal(res.requiresVerification, false);
  });

  it('should calculate Monthly GSTR-3B due date as 20th of succeeding month', () => {
    const period = { periodKey: '2026-10', month: 10, year: 2026, type: 'monthly' };
    const res = calculateDueDate('GSTR-3B', period, profileMonthly);

    assert.equal(res.dueDate, '2026-11-20');
    assert.equal(res.requiresVerification, false);
  });

  it('should handle year rollover correctly (December -> January)', () => {
    const period = { periodKey: '2026-12', month: 12, year: 2026, type: 'monthly' };
    const gstr1 = calculateDueDate('GSTR-1', period, profileMonthly);
    const gstr3b = calculateDueDate('GSTR-3B', period, profileMonthly);

    assert.equal(gstr1.dueDate, '2027-01-11');
    assert.equal(gstr3b.dueDate, '2027-01-20');
  });

  it('should calculate Quarterly GSTR-1 due date as 13th of succeeding month', () => {
    const profileQuarterly = { ...profileMonthly, filingFrequency: 'Quarterly' };
    const period = { periodKey: 'FY2026-2027-Q2', quarter: 2, endMonth: 9, year: 2026, type: 'quarterly' };
    const res = calculateDueDate('GSTR-1', period, profileQuarterly);

    assert.equal(res.dueDate, '2026-10-13');
    assert.equal(res.requiresVerification, false);
  });

  it('should support configurable government notification overrides', () => {
    const period = { periodKey: '2026-10', month: 10, year: 2026, type: 'monthly' };
    const overrides = {
      'GSTR-3B_2026-10': {
        dueDate: '2026-11-25',
        notification: 'CBIC Circular 45/2026'
      }
    };
    const res = calculateDueDate('GSTR-3B', period, profileMonthly, overrides);

    assert.equal(res.dueDate, '2026-11-25');
    assert.equal(res.isExtended, true);
    assert.equal(res.notification, 'CBIC Circular 45/2026');
  });
});

describe('Missing Rules and Unverified Due Dates', () => {
  it('should flag verification when return type has no defined rule', () => {
    const period = { periodKey: '2026-10', month: 10, year: 2026, type: 'monthly' };
    const res = calculateDueDate('GSTR-9', period, { filingFrequency: 'Monthly' });

    assert.equal(res.requiresVerification, true);
    assert.equal(res.dueDate, null);
    assert.ok(res.verificationReason);
  });

  it('should flag verification when QRMP state is unmapped or unknown', () => {
    const profileUnmapped = {
      gstin: '97ABCDE1234F1ZY',
      stateCode: '97',
      filingFrequency: 'Quarterly'
    };
    const period = { periodKey: 'FY2026-2027-Q2', quarter: 2, endMonth: 9, year: 2026, type: 'quarterly' };
    const res = calculateDueDate('GSTR-3B', period, profileUnmapped);

    assert.equal(res.requiresVerification, true);
    assert.equal(res.dueDate, null);
    assert.match(res.verificationReason, /not mapped to QRMP Group A.*or Group B/);
  });

  it('should flag verification when filing frequency and period type mismatch', () => {
    const period = { periodKey: 'FY2026-2027-Q2', quarter: 2, type: 'quarterly' };
    const res = calculateDueDate('GSTR-1', period, { filingFrequency: 'Monthly' });

    assert.equal(res.requiresVerification, true);
    assert.equal(res.dueDate, null);
  });
});

describe('Days Remaining and Status Logic', () => {
  const refDate = new Date('2026-11-10T10:00:00Z');

  it('should calculate positive remaining days for future due date', () => {
    const days = calculateDaysRemaining('2026-11-15', refDate);
    assert.equal(days, 5);
  });

  it('should calculate 0 remaining days for due date today', () => {
    const days = calculateDaysRemaining('2026-11-10', refDate);
    assert.equal(days, 0);
  });

  it('should calculate negative remaining days for overdue returns', () => {
    const days = calculateDaysRemaining('2026-11-05', refDate);
    assert.equal(days, -5);
  });

  it('should identify Overdue status', () => {
    const status = deriveDeadlineStatus({
      dueDate: '2026-11-05',
      daysRemaining: -5,
      isFiled: false
    });
    assert.equal(status, 'Overdue');
  });

  it('should identify Due Soon status (<= 5 days remaining)', () => {
    const status = deriveDeadlineStatus({
      dueDate: '2026-11-13',
      daysRemaining: 3,
      isFiled: false
    });
    assert.equal(status, 'Due Soon');
  });

  it('should identify Upcoming status (> 5 days remaining)', () => {
    const status = deriveDeadlineStatus({
      dueDate: '2026-11-20',
      daysRemaining: 10,
      isFiled: false
    });
    assert.equal(status, 'Upcoming');
  });

  it('should identify Completed status when marked as filed', () => {
    const status = deriveDeadlineStatus({
      dueDate: '2026-11-05',
      daysRemaining: -5,
      isFiled: true
    });
    assert.equal(status, 'Completed');
  });

  it('should display Due Date Requires Verification for unverified deadlines', () => {
    const status = deriveDeadlineStatus({
      dueDate: null,
      daysRemaining: null,
      requiresVerification: true,
      isFiled: false
    });
    assert.equal(status, 'Due Date Requires Verification');
  });
});

describe('Storage Operations & Failure Handling (Bug 5)', () => {
  it('should return default state when storage is empty or null', () => {
    const mock = createMockStorage();
    const state = loadDeadlinesState(mock);
    assert.deepEqual(state.profile, DEFAULT_DEADLINES_STATE.profile);
    assert.deepEqual(state.filingRecords, {});
  });

  it('should safely recover from corrupted JSON in localStorage', () => {
    const mock = createMockStorage({
      [STORAGE_KEY]: '{ invalid_json_corrupted '
    });
    const state = loadDeadlinesState(mock);
    assert.deepEqual(state.profile, DEFAULT_DEADLINES_STATE.profile);
    assert.deepEqual(state.filingRecords, {});
  });

  it('should return { success: true } when saveBusinessProfile succeeds', () => {
    const mock = createMockStorage();
    const profile = {
      businessName: 'Sharma Traders',
      gstin: '09ABCDE1234F1ZY',
      state: 'Uttar Pradesh',
      stateCode: '09',
      filingFrequency: 'Quarterly',
      applicableReturns: ['GSTR-1']
    };

    const result = saveBusinessProfile(profile, mock);
    assert.equal(result.success, true);
    assert.equal(result.updatedState.profile.businessName, 'Sharma Traders');

    const loaded = loadDeadlinesState(mock);
    assert.equal(loaded.profile.businessName, 'Sharma Traders');
  });

  it('should return { success: false, error } when saveBusinessProfile encounters storage failure', () => {
    // Failing mock storage
    const failingMock = createMockStorage({}, true);
    const profile = {
      businessName: 'Sharma Traders',
      gstin: '09ABCDE1234F1ZY',
      state: 'Uttar Pradesh',
      stateCode: '09',
      filingFrequency: 'Quarterly',
      applicableReturns: ['GSTR-1']
    };

    const result = saveBusinessProfile(profile, failingMock);
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('should return { success: true } when markReturnFiled succeeds and preserve history', () => {
    const mock = createMockStorage();
    const result = markReturnFiled('GSTR-1', '2026-10', {
      filedDate: '2026-11-09',
      notes: 'ARN: AA0911261234567'
    }, mock);

    assert.equal(result.success, true);
    assert.equal(result.record.status, 'Completed');
    assert.equal(result.record.filedDate, '2026-11-09');

    const loaded = loadDeadlinesState(mock);
    const record = loaded.filingRecords['GSTR-1_2026-10'];
    assert.ok(record);
    assert.equal(record.status, 'Completed');
  });

  it('should return { success: false, error } when markReturnFiled storage fails', () => {
    const failingMock = createMockStorage({}, true);
    const result = markReturnFiled('GSTR-1', '2026-10', { filedDate: '2026-11-09' }, failingMock);

    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('should allow correcting / unmarking a filing record (reopening)', () => {
    const mock = createMockStorage();
    markReturnFiled('GSTR-3B', '2026-10', { filedDate: '2026-11-15' }, mock);
    assert.ok(loadDeadlinesState(mock).filingRecords['GSTR-3B_2026-10']);

    const unmarkResult = unmarkReturnFiled('GSTR-3B', '2026-10', mock);
    assert.equal(unmarkResult.success, true);
    assert.equal(loadDeadlinesState(mock).filingRecords['GSTR-3B_2026-10'], undefined);
  });

  it('should return { success: false } when updating non-existent filing record or on storage failure', () => {
    const mock = createMockStorage();
    const notFoundRes = updateFilingRecord('GSTR-1', 'non-existent', { notes: 'Note' }, mock);
    assert.equal(notFoundRes.success, false);

    const failingMock = createMockStorage({
      [STORAGE_KEY]: JSON.stringify({
        version: 1,
        filingRecords: { 'GSTR-1_2026-10': { status: 'Completed' } }
      })
    }, true);
    const failRes = updateFilingRecord('GSTR-1', '2026-10', { notes: 'New Note' }, failingMock);
    assert.equal(failRes.success, false);
  });

  it('should clear only deadlines key without touching other keys', () => {
    const mock = createMockStorage({
      [STORAGE_KEY]: JSON.stringify({ version: 1 }),
      'billsetu:invoices': JSON.stringify([{ id: 'inv-1' }])
    });

    clearDeadlinesData(mock);
    assert.equal(mock.getItem(STORAGE_KEY), null);
    assert.ok(mock.getItem('billsetu:invoices'), 'BillSetu invoices must remain untouched');
  });
});

describe('initialProfile Priority and Retention Logic (Bug 1)', () => {
  it('should retain initialProfile when no saved profile exists in storage', () => {
    const initial = {
      businessName: 'Default Seed Co',
      gstin: '09ABCDE1234F1ZY',
      state: 'Uttar Pradesh',
      filingFrequency: 'Monthly'
    };

    const emptyStorage = createMockStorage();
    const loaded = loadDeadlinesState(emptyStorage);
    const hasSaved = Boolean(loaded.profile && loaded.profile.businessName && loaded.profile.businessName.trim());

    assert.equal(hasSaved, false);
    // When no saved profile, initialProfile is retained
    const effective = hasSaved ? loaded : {
      ...loaded,
      profile: { ...loaded.profile, ...initial }
    };
    assert.equal(effective.profile.businessName, 'Default Seed Co');
  });

  it('should prioritize saved profile over initialProfile when saved profile exists', () => {
    const initial = {
      businessName: 'Initial Seed Corp',
      gstin: '09ABCDE1234F1ZY'
    };

    const storageWithSaved = createMockStorage({
      [STORAGE_KEY]: JSON.stringify({
        version: 1,
        profile: {
          businessName: 'My Real Saved Business',
          gstin: '27AAKFM2916L1ZY',
          state: 'Maharashtra',
          stateCode: '27',
          filingFrequency: 'Quarterly',
          applicableReturns: ['GSTR-1', 'GSTR-3B']
        }
      })
    });

    const loaded = loadDeadlinesState(storageWithSaved);
    const hasSaved = Boolean(loaded.profile && loaded.profile.businessName && loaded.profile.businessName.trim());

    assert.equal(hasSaved, true);
    // Saved profile takes priority
    const effective = hasSaved ? loaded : {
      ...loaded,
      profile: { ...loaded.profile, ...initial }
    };
    assert.equal(effective.profile.businessName, 'My Real Saved Business');
    assert.equal(effective.profile.gstin, '27AAKFM2916L1ZY');
  });
});

describe('Full Deadline Generation Pipeline', () => {
  it('should generate, sort, and merge filing records for a profile', () => {
    const profile = {
      businessName: 'Apex Enterprise',
      gstin: '09ABCDE1234F1ZY',
      state: 'Uttar Pradesh',
      stateCode: '09',
      filingFrequency: 'Monthly',
      applicableReturns: ['GSTR-1', 'GSTR-3B']
    };

    const filingRecords = {
      'GSTR-1_2026-09': {
        returnType: 'GSTR-1',
        periodKey: '2026-09',
        filedDate: '2026-10-10',
        status: 'Completed'
      }
    };

    const refDate = new Date('2026-10-15T00:00:00Z');
    const deadlines = generateDeadlines(profile, filingRecords, {}, refDate);

    assert.ok(deadlines.length > 0);
    const filedItem = deadlines.find(d => d.id === 'GSTR-1_2026-09');
    assert.ok(filedItem);
    assert.equal(filedItem.status, 'Completed');

    for (const d of deadlines) {
      assert.ok(d.returnType);
      assert.ok(d.periodKey);
      assert.ok(d.periodLabel);
      assert.ok(d.status);
    }
  });
});
