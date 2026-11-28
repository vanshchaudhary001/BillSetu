/**
 * GST Filing Deadline Rules and Period Calculations for BillSetu
 *
 * Implements statutory Indian GST due date rules for regular taxpayers,
 * supporting Monthly and Quarterly (QRMP) filing frequencies, state-specific
 * group categorizations, and configurable due-date overrides.
 */

export const STATE_CODES = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory'
};

/**
 * QRMP Category 1 (Group A) States: Due date for quarterly GSTR-3B is 22nd of succeeding month.
 */
export const QRMP_GROUP_A_STATE_CODES = new Set([
  '22', '23', '24', '27', '29', '30', '31', '32', '33', '34', '35', '36', '37', '26'
]);

/**
 * QRMP Category 2 (Group B) States: Due date for quarterly GSTR-3B is 24th of succeeding month.
 */
export const QRMP_GROUP_B_STATE_CODES = new Set([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '21', '38'
]);

export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Validates Mod-36 checksum for 15-character Indian GSTIN.
 */
export function gstinChecksumValid(value) {
  const gstin = String(value || '').trim().toUpperCase();
  if (!GSTIN_REGEX.test(gstin)) return false;
  let sum = 0;
  let factor = 1;
  for (const char of gstin.slice(0, 14)) {
    const product = GSTIN_ALPHABET.indexOf(char) * factor;
    sum += Math.floor(product / 36) + (product % 36);
    factor = factor === 1 ? 2 : 1;
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36] === gstin[14];
}

/**
 * Validates GSTIN structure, valid state code, and optional checksum.
 */
export function validateGSTIN(rawGstin) {
  const gstin = String(rawGstin || '').trim().toUpperCase();
  if (!gstin) {
    return { isValid: false, error: 'GSTIN is required.' };
  }
  if (!GSTIN_REGEX.test(gstin)) {
    return {
      isValid: false,
      error: 'Invalid GSTIN format. Expected 15 characters (e.g. 07AAAAA0000A1Z5).'
    };
  }
  const stateCode = gstin.slice(0, 2);
  const stateName = STATE_CODES[stateCode];
  if (!stateName) {
    return {
      isValid: false,
      error: `Invalid state code '${stateCode}' in GSTIN.`
    };
  }
  const checksumOk = gstinChecksumValid(gstin);
  return {
    isValid: true,
    gstin,
    stateCode,
    stateName,
    checksumValid: checksumOk,
    warning: checksumOk ? undefined : 'GSTIN format is valid, but checksum check failed.'
  };
}

/**
 * Validates the Business Profile required fields.
 * Strictly verifies that the selected state matches the GSTIN state prefix.
 */
export function validateProfile(profile = {}) {
  const errors = {};
  const businessName = String(profile.businessName || '').trim();
  if (!businessName) {
    errors.businessName = 'Business name is required.';
  }

  const gstinValidation = validateGSTIN(profile.gstin);
  if (!gstinValidation.isValid) {
    errors.gstin = gstinValidation.error;
  }

  const state = String(profile.state || '').trim();
  if (!state) {
    errors.state = 'State is required.';
  }

  // Cross-validation: selected state name must match GSTIN state name,
  // and supplied stateCode must independently match GSTIN state code.
  if (gstinValidation.isValid && state) {
    const expectedStateName = gstinValidation.stateName;
    const expectedStateCode = gstinValidation.stateCode;
    const matchesName = state.trim().toLowerCase() === expectedStateName.toLowerCase();
    const suppliedStateCode = profile.stateCode !== undefined && profile.stateCode !== null
      ? String(profile.stateCode).trim()
      : '';
    const hasSuppliedCode = suppliedStateCode !== '';
    const matchesCode = !hasSuppliedCode || suppliedStateCode === expectedStateCode;

    if (!matchesName && !matchesCode) {
      errors.state = `Selected state '${state}' and state code '${suppliedStateCode}' do not match GSTIN state '${expectedStateName}' (${expectedStateCode}).`;
    } else if (!matchesName) {
      errors.state = `Selected state '${state}' does not match GSTIN state '${expectedStateName}' (${expectedStateCode}).`;
    } else if (!matchesCode) {
      errors.state = `Selected state code '${suppliedStateCode}' does not match GSTIN state code '${expectedStateCode}' (${expectedStateName}).`;
    }
  }

  const filingFrequency = profile.filingFrequency;
  if (!['Monthly', 'Quarterly'].includes(filingFrequency)) {
    errors.filingFrequency = "Filing frequency must be 'Monthly' or 'Quarterly'.";
  }

  const applicableReturns = Array.isArray(profile.applicableReturns)
    ? profile.applicableReturns
    : [];
  if (applicableReturns.length === 0) {
    errors.applicableReturns = 'At least one return type (GSTR-1 or GSTR-3B) must be selected.';
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors
  };
}

/**
 * Checks if a year is a leap year in the Gregorian calendar.
 */
export function isLeapYear(year) {
  const y = Number(year);
  if (!Number.isInteger(y)) return false;
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

/**
 * Returns the exact number of days in a given month (1-12) of a year.
 */
export function getDaysInMonth(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return 0;
  if (m === 2) {
    return isLeapYear(y) ? 29 : 28;
  }
  if ([4, 6, 9, 11].includes(m)) {
    return 30;
  }
  return 31;
}

/**
 * Validates strictly whether year, month, day represent a genuine calendar date.
 * Does not silently normalize or roll over invalid dates.
 */
export function isValidCalendarDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) {
    return false;
  }
  const maxDays = getDaysInMonth(y, m);
  return d <= maxDays;
}

/**
 * Validates strictly a 'YYYY-MM-DD' formatted calendar date string.
 */
export function isValidCalendarDateStr(dateStr) {
  if (typeof dateStr !== 'string') return false;
  const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return isValidCalendarDate(y, m, d);
}

// Strict regex for Date only: YYYY-MM-DD
const ISO_DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

// Strict regex for ISO 8601 Datetime: YYYY-MM-DDTHH:mm:ss.sssZ, with optional seconds, ms, and tz offset
const ISO_DATETIME_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/;

/**
 * Validates strict timezone offset hours (00-14) and minutes (00-59).
 * If hours is 14, minutes must be 00.
 */
export function isValidTimezoneOffset(hours, minutes) {
  const h = Number(hours);
  const m = Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return false;
  if (h < 0 || h > 14) return false;
  if (m < 0 || m > 59) return false;
  if (h === 14 && m !== 0) return false;
  return true;
}

/**
 * Normalizes a date to YYYY-MM-DD string.
 * Strictly validates calendar dates, rejects trailing garbage characters or malformed suffixes.
 * Validates timezone offsets strictly:
 * - Offset hours must be between 00 and 14.
 * - Offset minutes must be between 00 and 59.
 * - If offset hours are 14, offset minutes must be 00.
 * Supports:
 * - Valid Date objects
 * - Strict 'YYYY-MM-DD' strings
 * - Strict ISO 8601 datetime strings (e.g. 'YYYY-MM-DDTHH:mm:ssZ', 'YYYY-MM-DDTHH:mm:ss+05:30', 'YYYY-MM-DDTHH:mm:ss-12:00', 'YYYY-MM-DDTHH:mm:ss+14:00')
 */
export function toIsoDate(date) {
  if (!date) return '';

  if (typeof date === 'string') {
    const trimmed = date.trim();
    if (!trimmed) return '';

    // 1. Strict YYYY-MM-DD date-only check
    const dateMatch = trimmed.match(ISO_DATE_ONLY_REGEX);
    if (dateMatch) {
      const y = Number(dateMatch[1]);
      const m = Number(dateMatch[2]);
      const d = Number(dateMatch[3]);
      if (!isValidCalendarDate(y, m, d)) {
        return '';
      }
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    // 2. Strict ISO datetime format check (entire string must match ISO_DATETIME_REGEX)
    const dtMatch = trimmed.match(ISO_DATETIME_REGEX);
    if (dtMatch) {
      const y = Number(dtMatch[1]);
      const m = Number(dtMatch[2]);
      const d = Number(dtMatch[3]);
      if (!isValidCalendarDate(y, m, d)) {
        return '';
      }
      const hour = Number(dtMatch[4]);
      const minute = Number(dtMatch[5]);
      const second = dtMatch[6] !== undefined ? Number(dtMatch[6]) : 0;
      if (hour > 23 || minute > 59 || second > 59) {
        return '';
      }

      // 3. Strict timezone offset validation if numeric offset is present
      const tzSign = dtMatch[9];
      if (tzSign) {
        const tzHour = Number(dtMatch[10]);
        const tzMinute = Number(dtMatch[11]);
        if (!isValidTimezoneOffset(tzHour, tzMinute)) {
          return '';
        }
      }

      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    // Any other string format (e.g. trailing characters like '2024-02-29garbage', invalid separators, etc.) is rejected
    return '';
  }

  if (date instanceof Date) {
    if (Number.isNaN(date.valueOf())) return '';
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    if (!isValidCalendarDate(year, month, day)) return '';
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  return '';
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Generates sequential monthly tax periods around a reference date.
 */
export function generateMonthlyPeriods(referenceDate = new Date(), countPast = 4, countFuture = 2) {
  const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (Number.isNaN(ref.valueOf())) return [];

  const periods = [];
  const currentMonthIdx = ref.getMonth();
  const currentYear = ref.getFullYear();

  for (let offset = -countPast; offset <= countFuture; offset++) {
    const targetDate = new Date(currentYear, currentMonthIdx + offset, 1);
    const y = targetDate.getFullYear();
    const m = targetDate.getMonth() + 1; // 1-12
    const mStr = String(m).padStart(2, '0');
    const lastDay = getDaysInMonth(y, m);
    periods.push({
      periodKey: `${y}-${mStr}`,
      label: `${MONTH_NAMES[m - 1]} ${y}`,
      month: m,
      year: y,
      type: 'monthly',
      endDate: `${y}-${mStr}-${String(lastDay).padStart(2, '0')}`
    });
  }
  return periods;
}

/**
 * Generates sequential financial quarter periods around a reference date.
 * Financial quarters in India:
 * Q1: Apr - Jun (ends 30 Jun)
 * Q2: Jul - Sep (ends 30 Sep)
 * Q3: Oct - Dec (ends 31 Dec)
 * Q4: Jan - Mar (ends 31 Mar)
 */
export function generateQuarterlyPeriods(referenceDate = new Date(), countPast = 3, countFuture = 1) {
  const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (Number.isNaN(ref.valueOf())) return [];

  const currentMonth = ref.getMonth() + 1; // 1-12
  const currentYear = ref.getFullYear();

  let currentQ;
  let fyYear;
  if (currentMonth >= 4 && currentMonth <= 6) {
    currentQ = 1;
    fyYear = currentYear;
  } else if (currentMonth >= 7 && currentMonth <= 9) {
    currentQ = 2;
    fyYear = currentYear;
  } else if (currentMonth >= 10 && currentMonth <= 12) {
    currentQ = 3;
    fyYear = currentYear;
  } else {
    currentQ = 4;
    fyYear = currentYear - 1;
  }

  const quarterMeta = {
    1: { name: 'Q1 (Apr - Jun)', endMonth: 6, endDay: 30, endYearOffset: 0 },
    2: { name: 'Q2 (Jul - Sep)', endMonth: 9, endDay: 30, endYearOffset: 0 },
    3: { name: 'Q3 (Oct - Dec)', endMonth: 12, endDay: 31, endYearOffset: 0 },
    4: { name: 'Q4 (Jan - Mar)', endMonth: 3, endDay: 31, endYearOffset: 1 }
  };

  const quarters = [];
  const currentTotalQ = fyYear * 4 + (currentQ - 1);

  for (let offset = -countPast; offset <= countFuture; offset++) {
    const totalQ = currentTotalQ + offset;
    const targetFy = Math.floor(totalQ / 4);
    const targetQ = (totalQ % 4) + 1;
    const meta = quarterMeta[targetQ];
    const endYear = targetFy + meta.endYearOffset;
    const mStr = String(meta.endMonth).padStart(2, '0');
    const dStr = String(meta.endDay).padStart(2, '0');

    quarters.push({
      periodKey: `FY${targetFy}-${targetFy + 1}-Q${targetQ}`,
      label: `${meta.name} ${targetQ === 4 ? `${targetFy + 1}` : `${targetFy}`}`,
      quarter: targetQ,
      fyYear: targetFy,
      year: endYear,
      endMonth: meta.endMonth,
      type: 'quarterly',
      endDate: `${endYear}-${mStr}-${dStr}`
    });
  }
  return quarters;
}

/**
 * Calculates the statutory due date for a given return and period.
 * Supports configurable overrides and flags unverified dates.
 * Ensures QRMP state grouping is consistent with GSTIN and rejects conflicting manual states.
 */
export function calculateDueDate(returnType, period, profile = {}, overrides = {}) {
  if (!returnType || !period) {
    return {
      dueDate: null,
      requiresVerification: true,
      verificationReason: 'Missing return type or tax period.'
    };
  }

  // Check for explicit override / government notification
  const overrideKey = `${returnType}_${period.periodKey}`;
  if (overrides[overrideKey]) {
    const override = overrides[overrideKey];
    const overrideDate = override.dueDate;
    if (overrideDate && !isValidCalendarDateStr(overrideDate)) {
      return {
        dueDate: null,
        requiresVerification: true,
        verificationReason: `Configured override date '${overrideDate}' is not a valid calendar date.`
      };
    }
    return {
      dueDate: overrideDate,
      requiresVerification: Boolean(override.requiresVerification),
      verificationReason: override.verificationReason || null,
      isExtended: true,
      notification: override.notification || 'Government Notification'
    };
  }

  const frequency = profile.filingFrequency || (period.type === 'quarterly' ? 'Quarterly' : 'Monthly');

  // MONTHLY FILERS
  if (frequency === 'Monthly') {
    if (period.type !== 'monthly') {
      return {
        dueDate: null,
        requiresVerification: true,
        verificationReason: 'Monthly filer received quarterly period.'
      };
    }
    const { year, month } = period;
    const succeedingMonth = month === 12 ? 1 : month + 1;
    const succeedingYear = month === 12 ? year + 1 : year;
    const smStr = String(succeedingMonth).padStart(2, '0');

    if (returnType === 'GSTR-1') {
      return {
        dueDate: `${succeedingYear}-${smStr}-11`,
        requiresVerification: false,
        ruleDescription: '11th of month succeeding tax period (Monthly GSTR-1)'
      };
    }

    if (returnType === 'GSTR-3B') {
      return {
        dueDate: `${succeedingYear}-${smStr}-20`,
        requiresVerification: false,
        ruleDescription: '20th of month succeeding tax period (Monthly GSTR-3B)'
      };
    }

    return {
      dueDate: null,
      requiresVerification: true,
      verificationReason: `No standard monthly rule defined for return '${returnType}'.`
    };
  }

  // QUARTERLY FILERS (QRMP)
  if (frequency === 'Quarterly') {
    if (period.type !== 'quarterly') {
      return {
        dueDate: null,
        requiresVerification: true,
        verificationReason: 'Quarterly filer received monthly period.'
      };
    }
    const endMonth = period.endMonth;
    const endYear = period.year;
    const succeedingMonth = endMonth === 12 ? 1 : endMonth + 1;
    const succeedingYear = endMonth === 12 ? endYear + 1 : endYear;
    const smStr = String(succeedingMonth).padStart(2, '0');

    if (returnType === 'GSTR-1') {
      return {
        dueDate: `${succeedingYear}-${smStr}-13`,
        requiresVerification: false,
        ruleDescription: '13th of month succeeding quarter (Quarterly GSTR-1 / QRMP)'
      };
    }

    if (returnType === 'GSTR-3B') {
      // Determine state code from GSTIN first (canonical source)
      const gstinStateCode = profile.gstin ? String(profile.gstin).trim().slice(0, 2) : '';
      const manualStateCode = profile.stateCode || '';

      // Check for conflict between manual state and GSTIN state
      if (gstinStateCode && STATE_CODES[gstinStateCode]) {
        if (manualStateCode && manualStateCode !== gstinStateCode) {
          return {
            dueDate: null,
            requiresVerification: true,
            verificationReason: `Selected state code '${manualStateCode}' conflicts with GSTIN state code '${gstinStateCode}'. Due date requires verification.`
          };
        }
        if (profile.state && STATE_CODES[gstinStateCode].toLowerCase() !== String(profile.state).trim().toLowerCase()) {
          return {
            dueDate: null,
            requiresVerification: true,
            verificationReason: `Selected state '${profile.state}' conflicts with GSTIN state '${STATE_CODES[gstinStateCode]}'. Due date requires verification.`
          };
        }
      }

      // State code to use: strictly consistent with GSTIN
      const stateCode = gstinStateCode || manualStateCode;

      if (QRMP_GROUP_A_STATE_CODES.has(stateCode)) {
        return {
          dueDate: `${succeedingYear}-${smStr}-22`,
          requiresVerification: false,
          ruleDescription: '22nd of month succeeding quarter (QRMP Category 1 / Group A)'
        };
      }

      if (QRMP_GROUP_B_STATE_CODES.has(stateCode)) {
        return {
          dueDate: `${succeedingYear}-${smStr}-24`,
          requiresVerification: false,
          ruleDescription: '24th of month succeeding quarter (QRMP Category 2 / Group B)'
        };
      }

      return {
        dueDate: null,
        requiresVerification: true,
        verificationReason: `State code '${stateCode || 'Unknown'}' is not mapped to QRMP Group A (22nd) or Group B (24th). Requires verification.`
      };
    }

    return {
      dueDate: null,
      requiresVerification: true,
      verificationReason: `No standard quarterly rule defined for return '${returnType}'.`
    };
  }

  return {
    dueDate: null,
    requiresVerification: true,
    verificationReason: `Unsupported filing frequency '${frequency}'.`
  };
}

/**
 * Calculates calendar days remaining until the due date from a reference date.
 * Strictly validates calendar dates (e.g. rejects 2026-02-31, 2026-02-29).
 * Returns negative numbers if overdue, 0 if due today, and positive if upcoming.
 * Returns null if either date is invalid.
 */
export function calculateDaysRemaining(dueDateStr, referenceDate = new Date()) {
  if (!dueDateStr || !isValidCalendarDateStr(dueDateStr)) return null;

  const match = String(dueDateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!isValidCalendarDate(y, m, d)) return null;

  const dueMidnight = new Date(y, m - 1, d);

  let refMidnight;
  if (typeof referenceDate === 'string') {
    if (!isValidCalendarDateStr(referenceDate)) return null;
    const rMatch = referenceDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!rMatch) return null;
    const ry = Number(rMatch[1]);
    const rm = Number(rMatch[2]);
    const rd = Number(rMatch[3]);
    if (!isValidCalendarDate(ry, rm, rd)) return null;
    refMidnight = new Date(ry, rm - 1, rd);
  } else if (referenceDate instanceof Date) {
    if (Number.isNaN(referenceDate.valueOf())) return null;
    refMidnight = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  } else {
    return null;
  }

  const diffMs = dueMidnight.getTime() - refMidnight.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return diffDays;
}

/**
 * Determines filing deadline status label.
 * Invalid dates strictly yield 'Due Date Requires Verification'.
 */
export function deriveDeadlineStatus({
  dueDate,
  daysRemaining,
  isFiled = false,
  requiresVerification = false,
  dueSoonThresholdDays = 5
}) {
  if (isFiled) {
    return 'Completed';
  }
  if (requiresVerification || !dueDate || !isValidCalendarDateStr(dueDate) || daysRemaining === null) {
    return 'Due Date Requires Verification';
  }
  if (daysRemaining < 0) {
    return 'Overdue';
  }
  if (daysRemaining <= dueSoonThresholdDays) {
    return 'Due Soon';
  }
  return 'Upcoming';
}

/**
 * Builds all deadline items for a business profile and merges with filing records.
 */
export function generateDeadlines(profile, filingRecords = {}, overrides = {}, referenceDate = new Date()) {
  if (!profile || !profile.applicableReturns || !profile.applicableReturns.length) {
    return [];
  }

  const frequency = profile.filingFrequency || 'Monthly';
  const periods = frequency === 'Quarterly'
    ? generateQuarterlyPeriods(referenceDate, 3, 2)
    : generateMonthlyPeriods(referenceDate, 4, 2);

  const deadlines = [];

  for (const period of periods) {
    for (const returnType of profile.applicableReturns) {
      const recordKey = `${returnType}_${period.periodKey}`;
      const filingRecord = filingRecords[recordKey];
      const isFiled = Boolean(filingRecord && filingRecord.status === 'Completed');

      const dueInfo = calculateDueDate(returnType, period, profile, overrides);

      // Verify that calculated due date is a valid calendar date
      const isValidDate = dueInfo.dueDate && isValidCalendarDateStr(dueInfo.dueDate);
      const effectiveDueDate = isValidDate ? dueInfo.dueDate : null;
      const effectiveRequiresVerification = dueInfo.requiresVerification || !isValidDate;

      const daysRemaining = effectiveDueDate
        ? calculateDaysRemaining(effectiveDueDate, referenceDate)
        : null;

      const status = deriveDeadlineStatus({
        dueDate: effectiveDueDate,
        daysRemaining,
        isFiled,
        requiresVerification: effectiveRequiresVerification
      });

      deadlines.push({
        id: recordKey,
        returnType,
        periodKey: period.periodKey,
        periodLabel: period.label,
        periodType: period.type,
        dueDate: effectiveDueDate,
        ruleDescription: dueInfo.ruleDescription || null,
        requiresVerification: effectiveRequiresVerification,
        verificationReason: !isValidDate && dueInfo.dueDate
          ? `Calculated due date '${dueInfo.dueDate}' is not a valid calendar date.`
          : (dueInfo.verificationReason || null),
        isExtended: Boolean(dueInfo.isExtended),
        notification: dueInfo.notification || null,
        daysRemaining,
        status,
        filingRecord: filingRecord || null
      });
    }
  }

  const statusWeight = {
    'Overdue': 1,
    'Due Soon': 2,
    'Due Date Requires Verification': 3,
    'Upcoming': 4,
    'Completed': 5
  };

  deadlines.sort((a, b) => {
    const weightDiff = (statusWeight[a.status] || 99) - (statusWeight[b.status] || 99);
    if (weightDiff !== 0) return weightDiff;
    if (a.dueDate && b.dueDate) {
      return a.dueDate.localeCompare(b.dueDate);
    }
    return a.periodKey.localeCompare(b.periodKey);
  });

  return deadlines;
}
