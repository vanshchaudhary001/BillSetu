/**
 * Independent LocalStorage Management for GST Filing Deadlines
 *
 * Dedicated storage key: 'billsetu_gst_deadlines_v1'
 * Completely isolated from BillSetu's existing invoice storage.
 * Robust error handling returning explicit success/failure results.
 */

export const STORAGE_KEY = 'billsetu_gst_deadlines_v1';

export const DEFAULT_DEADLINES_STATE = {
  version: 1,
  profile: {
    businessName: '',
    gstin: '',
    state: '',
    stateCode: '',
    filingFrequency: 'Monthly', // 'Monthly' | 'Quarterly'
    applicableReturns: ['GSTR-1', 'GSTR-3B']
  },
  filingRecords: {},
  overrides: {}
};

/**
 * Safely loads the deadlines state from storage.
 * Handles missing, null, or corrupted data safely by falling back to defaults.
 */
export function loadDeadlinesState(storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  if (!storage) {
    return JSON.parse(JSON.stringify(DEFAULT_DEADLINES_STATE));
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return JSON.parse(JSON.stringify(DEFAULT_DEADLINES_STATE));
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return JSON.parse(JSON.stringify(DEFAULT_DEADLINES_STATE));
    }

    return {
      version: parsed.version || 1,
      profile: {
        ...DEFAULT_DEADLINES_STATE.profile,
        ...(parsed.profile || {})
      },
      filingRecords: parsed.filingRecords && typeof parsed.filingRecords === 'object'
        ? parsed.filingRecords
        : {},
      overrides: parsed.overrides && typeof parsed.overrides === 'object'
        ? parsed.overrides
        : {}
    };
  } catch (err) {
    console.warn('BillSetu GST Deadlines: Failed to parse stored state, falling back to defaults.', err);
    return JSON.parse(JSON.stringify(DEFAULT_DEADLINES_STATE));
  }
}

/**
 * Safely saves the deadlines state to storage.
 * Returns true if successful, false if storage failed or threw an exception.
 */
export function saveDeadlinesState(state, storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  if (!storage) return false;
  try {
    const payload = JSON.stringify(state);
    storage.setItem(STORAGE_KEY, payload);
    return true;
  } catch (err) {
    console.error('BillSetu GST Deadlines: Could not save state to storage.', err);
    return false;
  }
}

/**
 * Updates and saves the business profile.
 * Returns { success, updatedState, error }
 */
export function saveBusinessProfile(profile, storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  try {
    const current = loadDeadlinesState(storage);
    const updated = {
      ...current,
      profile: {
        ...current.profile,
        ...profile
      }
    };
    const success = saveDeadlinesState(updated, storage);
    if (!success) {
      return {
        success: false,
        error: 'Failed to save business profile to storage.',
        state: current
      };
    }
    return {
      success: true,
      updatedState: updated,
      state: updated
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || 'Storage error while saving business profile.',
      state: null
    };
  }
}

/**
 * Records a return as filed.
 * Returns { success, updatedState, record, error }
 */
export function markReturnFiled(returnType, periodKey, filingDetails = {}, storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  try {
    const current = loadDeadlinesState(storage);
    const recordKey = `${returnType}_${periodKey}`;
    const nowIso = new Date().toISOString();

    const record = {
      returnType,
      periodKey,
      filedDate: filingDetails.filedDate || nowIso.slice(0, 10),
      acknowledgedAt: filingDetails.acknowledgedAt || nowIso,
      status: 'Completed',
      notes: filingDetails.notes || ''
    };

    const updated = {
      ...current,
      filingRecords: {
        ...current.filingRecords,
        [recordKey]: record
      }
    };

    const success = saveDeadlinesState(updated, storage);
    if (!success) {
      return {
        success: false,
        error: 'Failed to save filing record to storage.',
        state: current
      };
    }
    return {
      success: true,
      updatedState: updated,
      record
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || 'Storage error while marking return as filed.',
      state: null
    };
  }
}

/**
 * Removes a filing record (corrects/reopens a return marked as filed by mistake).
 * Returns { success, updatedState, error }
 */
export function unmarkReturnFiled(returnType, periodKey, storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  try {
    const current = loadDeadlinesState(storage);
    const recordKey = `${returnType}_${periodKey}`;

    const remainingRecords = { ...current.filingRecords };
    delete remainingRecords[recordKey];

    const updated = {
      ...current,
      filingRecords: remainingRecords
    };

    const success = saveDeadlinesState(updated, storage);
    if (!success) {
      return {
        success: false,
        error: 'Failed to remove filing record from storage.',
        state: current
      };
    }
    return {
      success: true,
      updatedState: updated
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || 'Storage error while reopening return.',
      state: null
    };
  }
}

/**
 * Updates an existing filing record (e.g. correcting the filing date or notes).
 * Returns { success, updatedState, error }
 */
export function updateFilingRecord(returnType, periodKey, updates = {}, storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  try {
    const current = loadDeadlinesState(storage);
    const recordKey = `${returnType}_${periodKey}`;
    if (!current.filingRecords[recordKey]) {
      return {
        success: false,
        error: `Filing record '${recordKey}' does not exist.`,
        state: current
      };
    }

    const updated = {
      ...current,
      filingRecords: {
        ...current.filingRecords,
        [recordKey]: {
          ...current.filingRecords[recordKey],
          ...updates
        }
      }
    };

    const success = saveDeadlinesState(updated, storage);
    if (!success) {
      return {
        success: false,
        error: 'Failed to update filing record in storage.',
        state: current
      };
    }
    return {
      success: true,
      updatedState: updated
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || 'Storage error while updating filing record.',
      state: null
    };
  }
}

/**
 * Clears only the GST deadlines storage key, without affecting any other BillSetu state.
 */
export function clearDeadlinesData(storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('BillSetu GST Deadlines: Could not clear storage key.', err);
  }
}
