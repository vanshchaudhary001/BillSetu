import React, { useState, useEffect, useMemo } from 'react';
import {
  STATE_CODES,
  validateGSTIN,
  validateProfile,
  generateDeadlines,
  calculateDaysRemaining,
  deriveDeadlineStatus,
  toIsoDate
} from './rules.js';
import {
  loadDeadlinesState,
  saveBusinessProfile,
  markReturnFiled,
  unmarkReturnFiled,
  updateFilingRecord
} from './storage.js';
import './deadlines.css';

// Lightweight, zero-dependency SVG icon set matching BillSetu's design
function IconCalendar({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="16" y1="2" x2="16" y2="6"></line>
      <line x1="8" y1="2" x2="8" y2="6"></line>
      <line x1="3" y1="10" x2="21" y2="10"></line>
    </svg>
  );
}

function IconCheck({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  );
}

function IconCheckCircle({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
      <polyline points="22 4 12 14.01 9 11.01"></polyline>
    </svg>
  );
}

function IconAlertTriangle({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
      <line x1="12" y1="9" x2="12" y2="13"></line>
      <line x1="12" y1="17" x2="12.01" y2="17"></line>
    </svg>
  );
}

function IconAlertCircle({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="12"></line>
      <line x1="12" y1="16" x2="12.01" y2="16"></line>
    </svg>
  );
}

function IconClock({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>
  );
}

function IconBuilding({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect>
      <path d="M9 22v-4h6v4"></path>
      <path d="M8 6h.01"></path>
      <path d="M16 6h.01"></path>
      <path d="M8 10h.01"></path>
      <path d="M16 10h.01"></path>
      <path d="M8 14h.01"></path>
      <path d="M16 14h.01"></path>
    </svg>
  );
}

function IconEdit({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
    </svg>
  );
}

function IconShield({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
    </svg>
  );
}

function IconClose({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="18" y1="6" x2="6" y2="18"></line>
      <line x1="6" y1="6" x2="18" y2="18"></line>
    </svg>
  );
}

function IconRotateCcw({ size = 14, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="1 4 1 10 7 10"></polyline>
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
    </svg>
  );
}

function formatDisplayDate(isoDateStr) {
  if (!isoDateStr) return 'Date to verify';
  const parts = String(isoDateStr).split('-');
  if (parts.length !== 3) return isoDateStr;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (Number.isNaN(d.valueOf())) return isoDateStr;
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

/**
 * Resolves the initial effective state:
 * - Saved profile in storage takes priority over initialProfile.
 * - If no saved business profile, initialProfile is retained.
 */
function resolveInitialState(initialProfile) {
  const loaded = loadDeadlinesState();
  const hasSavedProfile = Boolean(
    loaded.profile && loaded.profile.businessName && loaded.profile.businessName.trim()
  );
  if (!hasSavedProfile && initialProfile && initialProfile.businessName) {
    const gstin = initialProfile.gstin || '';
    const stateCode = initialProfile.stateCode || (gstin ? gstin.slice(0, 2) : '');
    const state = initialProfile.state || (STATE_CODES[stateCode] || '');
    return {
      ...loaded,
      profile: {
        ...loaded.profile,
        ...initialProfile,
        stateCode,
        state
      }
    };
  }
  return loaded;
}

export function GstDeadlinesDashboard({ initialProfile = null }) {
  // Initialize state once without subsequent overwrite on mount
  const [appState, setAppState] = useState(() => resolveInitialState(initialProfile));

  const [activeFilter, setActiveFilter] = useState('all'); // 'all' | 'dueSoon' | 'overdue' | 'completed'
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [filingModalDeadline, setFilingModalDeadline] = useState(null);
  const [editRecordDeadline, setEditRecordDeadline] = useState(null);
  const [storageErrorMessage, setStorageErrorMessage] = useState(null);

  // Profile Form State
  const [profileForm, setProfileForm] = useState({
    businessName: '',
    gstin: '',
    state: '',
    stateCode: '',
    filingFrequency: 'Monthly',
    applicableReturns: ['GSTR-1', 'GSTR-3B']
  });
  const [profileErrors, setProfileErrors] = useState({});

  // Filing Confirmation State
  const [filingForm, setFilingForm] = useState({
    filedDate: toIsoDate(new Date()),
    notes: '',
    confirmed: false
  });

  // Keep state synced if initialProfile prop changes later (only if no saved profile exists)
  useEffect(() => {
    setAppState(prev => {
      const hasSaved = Boolean(
        prev.profile && prev.profile.businessName && prev.profile.businessName.trim()
      );
      if (!hasSaved && initialProfile && initialProfile.businessName) {
        const gstin = initialProfile.gstin || '';
        const stateCode = initialProfile.stateCode || (gstin ? gstin.slice(0, 2) : '');
        const state = initialProfile.state || (STATE_CODES[stateCode] || '');
        return {
          ...prev,
          profile: {
            ...prev.profile,
            ...initialProfile,
            stateCode,
            state
          }
        };
      }
      return prev;
    });
  }, [initialProfile]);

  // Sync profile form whenever appState.profile updates or modal opens
  useEffect(() => {
    if (appState.profile) {
      setProfileForm({
        businessName: appState.profile.businessName || '',
        gstin: appState.profile.gstin || '',
        state: appState.profile.state || '',
        stateCode: appState.profile.stateCode || (appState.profile.gstin ? appState.profile.gstin.slice(0, 2) : ''),
        filingFrequency: appState.profile.filingFrequency || 'Monthly',
        applicableReturns: appState.profile.applicableReturns || ['GSTR-1', 'GSTR-3B']
      });
    }
  }, [appState.profile, profileModalOpen]);

  // Compute all deadlines
  const deadlines = useMemo(() => {
    if (!appState.profile || !appState.profile.businessName) {
      return [];
    }
    return generateDeadlines(
      appState.profile,
      appState.filingRecords || {},
      appState.overrides || {},
      new Date()
    );
  }, [appState]);

  // Metrics summary
  const metrics = useMemo(() => {
    let upcomingCount = 0;
    let dueSoonCount = 0;
    let overdueCount = 0;
    let completedCount = 0;

    for (const d of deadlines) {
      if (d.status === 'Completed') {
        completedCount++;
      } else if (d.status === 'Overdue') {
        overdueCount++;
      } else if (d.status === 'Due Soon') {
        dueSoonCount++;
      } else if (d.status === 'Upcoming' || d.status === 'Due Date Requires Verification') {
        upcomingCount++;
      }
    }

    return {
      totalUpcoming: upcomingCount + dueSoonCount + overdueCount,
      upcomingOnly: upcomingCount,
      dueSoon: dueSoonCount,
      overdue: overdueCount,
      completed: completedCount,
      total: deadlines.length
    };
  }, [deadlines]);

  // Filtered deadlines list
  const filteredDeadlines = useMemo(() => {
    if (activeFilter === 'all') return deadlines;
    if (activeFilter === 'dueSoon') {
      return deadlines.filter(d => d.status === 'Due Soon' || d.status === 'Upcoming');
    }
    if (activeFilter === 'overdue') {
      return deadlines.filter(d => d.status === 'Overdue');
    }
    if (activeFilter === 'completed') {
      return deadlines.filter(d => d.status === 'Completed');
    }
    return deadlines;
  }, [deadlines, activeFilter]);

  // Handle GSTIN change in profile form (preserves auto-detecting state)
  const handleGstinChange = (e) => {
    const rawVal = e.target.value.toUpperCase();
    const stateCode = rawVal.slice(0, 2);
    const matchedState = STATE_CODES[stateCode];

    setProfileForm(prev => ({
      ...prev,
      gstin: rawVal,
      stateCode: matchedState ? stateCode : prev.stateCode,
      state: matchedState ? matchedState : prev.state
    }));

    if (profileErrors.gstin) {
      setProfileErrors(prev => ({ ...prev, gstin: null }));
    }
    if (profileErrors.state) {
      setProfileErrors(prev => ({ ...prev, state: null }));
    }
  };

  // Handle manual state dropdown change
  const handleStateChange = (e) => {
    const st = e.target.value;
    const code = Object.entries(STATE_CODES).find(([, name]) => name === st)?.[0] || '';
    setProfileForm(prev => ({
      ...prev,
      state: st,
      stateCode: code
    }));

    if (profileErrors.state) {
      setProfileErrors(prev => ({ ...prev, state: null }));
    }
  };

  // Save profile with persistence check (Bug 5 fix: update UI only when persistence succeeds)
  const handleSaveProfile = (e) => {
    e.preventDefault();
    const validation = validateProfile(profileForm);
    if (!validation.isValid) {
      setProfileErrors(validation.errors);
      return;
    }

    const saveResult = saveBusinessProfile(profileForm);
    if (!saveResult.success) {
      setProfileErrors({
        form: saveResult.error || 'Failed to save business profile to storage. Please check browser storage settings.'
      });
      return;
    }

    setAppState(saveResult.updatedState);
    setProfileErrors({});
    setStorageErrorMessage(null);
    setProfileModalOpen(false);
  };

  // Open filing confirmation modal
  const handleOpenFilingModal = (deadline) => {
    setFilingModalDeadline(deadline);
    setFilingForm({
      filedDate: toIsoDate(new Date()),
      notes: '',
      confirmed: false
    });
  };

  // Confirm filing with persistence check (Bug 5 fix: update UI only when persistence succeeds)
  const handleConfirmFiling = () => {
    if (!filingModalDeadline) return;
    const result = markReturnFiled(
      filingModalDeadline.returnType,
      filingModalDeadline.periodKey,
      {
        filedDate: filingForm.filedDate,
        notes: filingForm.notes
      }
    );

    if (!result.success) {
      alert(result.error || 'Failed to save filing record to storage.');
      return;
    }

    setAppState(result.updatedState);
    setFilingModalDeadline(null);
  };

  // Reopen return (unmark as filed) with persistence check
  const handleUnmarkFiling = (deadline) => {
    if (!deadline) return;
    const confirmed = window.confirm(
      `Reopen ${deadline.returnType} (${deadline.periodLabel}) as unfiled?\nThis will remove the completed filing record.`
    );
    if (!confirmed) return;

    const result = unmarkReturnFiled(deadline.returnType, deadline.periodKey);
    if (!result.success) {
      alert(result.error || 'Failed to update storage.');
      return;
    }

    setAppState(result.updatedState);
    setEditRecordDeadline(null);
  };

  // Update filed record date/notes with persistence check
  const handleUpdateRecord = (e) => {
    e.preventDefault();
    if (!editRecordDeadline) return;
    const result = updateFilingRecord(
      editRecordDeadline.returnType,
      editRecordDeadline.periodKey,
      {
        filedDate: filingForm.filedDate,
        notes: filingForm.notes
      }
    );

    if (!result.success) {
      alert(result.error || 'Failed to update filing record in storage.');
      return;
    }

    setAppState(result.updatedState);
    setEditRecordDeadline(null);
  };

  const hasProfile = Boolean(appState.profile && appState.profile.businessName);

  return (
    <div className="gstd-wrapper">
      {/* Top Header */}
      <div className="gstd-header">
        <div className="gstd-title-group">
          <span className="gstd-eyebrow">
            <span className="gstd-live-dot"></span>
            Statutory Compliance Tracker
          </span>
          <h1>GST Filing Deadline Reminders</h1>
          <p className="gstd-subtitle">
            Track statutory GST filing obligations, manage deadlines, and record timely filings.
          </p>
        </div>

        <div className="gstd-header-actions">
          {hasProfile && (
            <button
              className="gstd-btn gstd-btn-secondary"
              onClick={() => setProfileModalOpen(true)}
            >
              <IconEdit size={14} />
              Edit Profile
            </button>
          )}
        </div>
      </div>

      {storageErrorMessage && (
        <div className="gstd-disclaimer gstd-disclaimer-warning" style={{ marginBottom: '16px' }}>
          <IconAlertTriangle size={18} style={{ flexShrink: 0 }} />
          <div>
            <strong>Storage Error:</strong> {storageErrorMessage}
          </div>
        </div>
      )}

      {/* Business Profile Bar */}
      {hasProfile ? (
        <div className="gstd-profile-card">
          <div className="gstd-profile-inner">
            <div className="gstd-profile-main">
              <div className="gstd-profile-icon">
                <IconBuilding size={22} />
              </div>
              <div className="gstd-profile-info">
                <h3>{appState.profile.businessName}</h3>
                <div className="gstd-profile-meta">
                  <span>GSTIN: <strong>{appState.profile.gstin}</strong></span>
                  <span className="gstd-chip gstd-chip-green">{appState.profile.state}</span>
                  <span className="gstd-chip gstd-chip-blue">{appState.profile.filingFrequency} Filer</span>
                  <span className="gstd-chip">
                    Returns: {appState.profile.applicableReturns.join(', ')}
                  </span>
                </div>
              </div>
            </div>

            <div>
              <button
                className="gstd-btn gstd-btn-outline-green gstd-btn-sm"
                onClick={() => setProfileModalOpen(true)}
              >
                Change Schedule / Frequency
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="gstd-profile-card" style={{ borderColor: '#d1e4d6', background: '#f5faf6' }}>
          <div className="gstd-profile-inner">
            <div className="gstd-profile-main">
              <div className="gstd-profile-icon" style={{ background: '#24483e', color: '#ffffff' }}>
                <IconBuilding size={22} />
              </div>
              <div className="gstd-profile-info">
                <h3>Set Up Your GST Business Profile</h3>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#556960' }}>
                  Configure your GSTIN, state, and filing frequency (Monthly or QRMP Quarterly) to generate accurate statutory deadlines.
                </p>
              </div>
            </div>
            <div>
              <button
                className="gstd-btn gstd-btn-primary"
                onClick={() => setProfileModalOpen(true)}
              >
                Set Up Profile
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="gstd-metrics-grid">
        <div
          className="gstd-metric-card gstd-metric-upcoming"
          style={{ cursor: 'pointer' }}
          onClick={() => setActiveFilter('all')}
        >
          <div className="gstd-metric-top">
            <span className="gstd-metric-label">Total Upcoming Returns</span>
            <div className="gstd-metric-icon-wrap">
              <IconCalendar size={17} />
            </div>
          </div>
          <div className="gstd-metric-val">{metrics.totalUpcoming}</div>
          <div className="gstd-metric-foot">Active statutory return deadlines</div>
        </div>

        <div
          className="gstd-metric-card gstd-metric-duesoon"
          style={{ cursor: 'pointer' }}
          onClick={() => setActiveFilter('dueSoon')}
        >
          <div className="gstd-metric-top">
            <span className="gstd-metric-label">Due Soon</span>
            <div className="gstd-metric-icon-wrap">
              <IconClock size={17} />
            </div>
          </div>
          <div className="gstd-metric-val" style={{ color: '#b5792b' }}>{metrics.dueSoon}</div>
          <div className="gstd-metric-foot">Due within the next 5 days</div>
        </div>

        <div
          className="gstd-metric-card gstd-metric-overdue"
          style={{ cursor: 'pointer' }}
          onClick={() => setActiveFilter('overdue')}
        >
          <div className="gstd-metric-top">
            <span className="gstd-metric-label">Overdue</span>
            <div className="gstd-metric-icon-wrap">
              <IconAlertCircle size={17} />
            </div>
          </div>
          <div className="gstd-metric-val" style={{ color: '#c95245' }}>{metrics.overdue}</div>
          <div className="gstd-metric-foot">Passed statutory due date</div>
        </div>

        <div
          className="gstd-metric-card gstd-metric-completed"
          style={{ cursor: 'pointer' }}
          onClick={() => setActiveFilter('completed')}
        >
          <div className="gstd-metric-top">
            <span className="gstd-metric-label">Completed</span>
            <div className="gstd-metric-icon-wrap">
              <IconCheckCircle size={17} />
            </div>
          </div>
          <div className="gstd-metric-val" style={{ color: '#277045' }}>{metrics.completed}</div>
          <div className="gstd-metric-foot">Recorded as filed in BillSetu</div>
        </div>
      </div>

      {/* Deadlines Table Panel */}
      <div className="gstd-panel">
        <div className="gstd-panel-header">
          <div className="gstd-filter-tabs">
            <button
              className={`gstd-tab ${activeFilter === 'all' ? 'active' : ''}`}
              onClick={() => setActiveFilter('all')}
            >
              All Deadlines
              <span className="gstd-tab-badge">{deadlines.length}</span>
            </button>
            <button
              className={`gstd-tab ${activeFilter === 'dueSoon' ? 'active' : ''}`}
              onClick={() => setActiveFilter('dueSoon')}
            >
              Upcoming & Due Soon
              <span className="gstd-tab-badge">{metrics.upcomingOnly + metrics.dueSoon}</span>
            </button>
            <button
              className={`gstd-tab ${activeFilter === 'overdue' ? 'active' : ''}`}
              onClick={() => setActiveFilter('overdue')}
            >
              Overdue
              <span className="gstd-tab-badge">{metrics.overdue}</span>
            </button>
            <button
              className={`gstd-tab ${activeFilter === 'completed' ? 'active' : ''}`}
              onClick={() => setActiveFilter('completed')}
            >
              Completed History
              <span className="gstd-tab-badge">{metrics.completed}</span>
            </button>
          </div>

          <div style={{ fontSize: '11px', color: '#7a8c84' }}>
            Showing {filteredDeadlines.length} of {deadlines.length} return periods
          </div>
        </div>

        {filteredDeadlines.length === 0 ? (
          <div className="gstd-empty-state">
            <div className="gstd-empty-icon">
              <IconCalendar size={24} />
            </div>
            <h4>No Deadlines in this View</h4>
            <p>
              {hasProfile
                ? 'There are currently no return periods matching your selected filter.'
                : 'Configure your GST business profile above to calculate statutory deadlines.'}
            </p>
            {!hasProfile && (
              <button
                className="gstd-btn gstd-btn-primary"
                style={{ marginTop: '8px' }}
                onClick={() => setProfileModalOpen(true)}
              >
                Set Up Profile
              </button>
            )}
          </div>
        ) : (
          <div className="gstd-table-wrap">
            <table className="gstd-table">
              <thead>
                <tr>
                  <th>Return Name</th>
                  <th>Tax Period</th>
                  <th>Due Date</th>
                  <th>Days Remaining</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredDeadlines.map((item) => {
                  const isCompleted = item.status === 'Completed';
                  const isOverdue = item.status === 'Overdue';
                  const isDueSoon = item.status === 'Due Soon';
                  const isUnverified = item.status === 'Due Date Requires Verification';

                  return (
                    <tr key={item.id}>
                      {/* Return Name */}
                      <td>
                        <div className="gstd-return-cell">
                          <span
                            className={`gstd-return-badge ${
                              item.returnType === 'GSTR-1' ? 'gstd-badge-gstr1' : 'gstd-badge-gstr3b'
                            }`}
                          >
                            {item.returnType}
                          </span>
                          <span className="gstd-return-name">
                            {item.returnType === 'GSTR-1' ? 'Outward Supplies' : 'Monthly Summary Return'}
                          </span>
                        </div>
                      </td>

                      {/* Tax Period */}
                      <td>
                        <div className="gstd-period-text">{item.periodLabel}</div>
                        <span className="gstd-period-sub">
                          {item.periodType === 'quarterly' ? 'Quarterly Schedule' : 'Monthly Schedule'}
                        </span>
                      </td>

                      {/* Due Date */}
                      <td>
                        <div className="gstd-date-cell">
                          <strong>{formatDisplayDate(item.dueDate)}</strong>
                          {item.isExtended && (
                            <span className="gstd-notification-tag">
                              <IconAlertTriangle size={10} />
                              Extended: {item.notification}
                            </span>
                          )}
                          {item.ruleDescription && (
                            <small>{item.ruleDescription}</small>
                          )}
                        </div>
                      </td>

                      {/* Days Remaining */}
                      <td>
                        {isCompleted ? (
                          <span className="gstd-days-badge gstd-days-muted">
                            <IconCheck size={14} style={{ color: '#2b794a' }} />
                            Filed
                          </span>
                        ) : isUnverified ? (
                          <span className="gstd-days-badge gstd-days-muted">
                            Verification Needed
                          </span>
                        ) : isOverdue ? (
                          <span className="gstd-days-badge gstd-days-overdue">
                            <IconAlertCircle size={14} />
                            {Math.abs(item.daysRemaining)} days overdue
                          </span>
                        ) : isDueSoon ? (
                          <span className="gstd-days-badge gstd-days-duesoon">
                            <IconClock size={14} />
                            {item.daysRemaining === 0 ? 'Due Today' : `${item.daysRemaining} days left`}
                          </span>
                        ) : (
                          <span className="gstd-days-badge gstd-days-upcoming">
                            {item.daysRemaining} days left
                          </span>
                        )}
                      </td>

                      {/* Status Badge */}
                      <td>
                        <span
                          className={`gstd-status-pill ${
                            isCompleted
                              ? 'status-completed'
                              : isOverdue
                              ? 'status-overdue'
                              : isDueSoon
                              ? 'status-duesoon'
                              : isUnverified
                              ? 'status-unverified'
                              : 'status-upcoming'
                          }`}
                        >
                          {item.status}
                        </span>
                      </td>

                      {/* Actions */}
                      <td style={{ textAlign: 'right' }}>
                        {isCompleted ? (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            <button
                              className="gstd-btn gstd-btn-secondary gstd-btn-sm"
                              title="Edit filing details"
                              onClick={() => {
                                setEditRecordDeadline(item);
                                setFilingForm({
                                  filedDate: item.filingRecord?.filedDate || toIsoDate(new Date()),
                                  notes: item.filingRecord?.notes || '',
                                  confirmed: true
                                });
                              }}
                            >
                              <IconEdit size={12} />
                              Details
                            </button>
                            <button
                              className="gstd-btn gstd-btn-danger-outline gstd-btn-sm"
                              title="Reopen return as unfiled"
                              onClick={() => handleUnmarkFiling(item)}
                            >
                              <IconRotateCcw size={12} />
                              Reopen
                            </button>
                          </div>
                        ) : (
                          <button
                            className="gstd-btn gstd-btn-primary gstd-btn-sm"
                            onClick={() => handleOpenFilingModal(item)}
                          >
                            <IconCheck size={12} />
                            Mark as Filed
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Compliance Disclaimer Notice */}
      <div className="gstd-disclaimer gstd-disclaimer-warning">
        <IconShield size={18} style={{ flexShrink: 0, marginTop: '2px' }} />
        <div>
          <strong>Statutory Compliance & Legal Disclaimer:</strong>
          <p style={{ margin: '3px 0 0' }}>
            Due dates calculated here reflect statutory timelines under the Central Goods and Services Tax Act and relevant rules.
            Government notifications or portal advisories may extend deadlines for specific states or taxpayer classes.
            Marking a return as filed records your internal compliance status within BillSetu; it does not constitute filing on the official GST Common Portal.
          </p>
        </div>
      </div>

      {/* Profile Form Modal */}
      {profileModalOpen && (
        <div className="gstd-modal-backdrop" onClick={() => setProfileModalOpen(false)}>
          <div className="gstd-modal" onClick={e => e.stopPropagation()}>
            <div className="gstd-modal-header">
              <h3>GST Business Profile</h3>
              <button
                className="gstd-close-btn"
                onClick={() => setProfileModalOpen(false)}
              >
                <IconClose size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveProfile}>
              <div className="gstd-modal-body">
                {profileErrors.form && (
                  <div className="gstd-disclaimer gstd-disclaimer-warning" style={{ marginBottom: '14px', background: '#fff5f4', borderColor: '#f7d2cd', color: '#c95245' }}>
                    <IconAlertCircle size={16} style={{ flexShrink: 0 }} />
                    <div>{profileErrors.form}</div>
                  </div>
                )}

                <div className="gstd-form-group">
                  <label className="gstd-label">Business Name *</label>
                  <input
                    type="text"
                    className={`gstd-input ${profileErrors.businessName ? 'error' : ''}`}
                    placeholder="e.g. Sharma Electricals"
                    value={profileForm.businessName}
                    onChange={e => {
                      setProfileForm({ ...profileForm, businessName: e.target.value });
                      if (profileErrors.businessName) setProfileErrors({ ...profileErrors, businessName: null });
                    }}
                  />
                  {profileErrors.businessName && (
                    <span className="gstd-error-msg">{profileErrors.businessName}</span>
                  )}
                </div>

                <div className="gstd-form-group">
                  <label className="gstd-label">GSTIN (15 Digits) *</label>
                  <input
                    type="text"
                    className={`gstd-input ${profileErrors.gstin ? 'error' : ''}`}
                    placeholder="e.g. 09ABCDE1234F1ZY"
                    maxLength={15}
                    value={profileForm.gstin}
                    onChange={handleGstinChange}
                  />
                  {profileErrors.gstin && (
                    <span className="gstd-error-msg">{profileErrors.gstin}</span>
                  )}
                </div>

                <div className="gstd-form-group">
                  <label className="gstd-label">Registered State *</label>
                  <select
                    className={`gstd-select ${profileErrors.state ? 'error' : ''}`}
                    value={profileForm.state}
                    onChange={handleStateChange}
                  >
                    <option value="">Select State</option>
                    {Object.entries(STATE_CODES).map(([code, name]) => (
                      <option key={code} value={name}>
                        {code} - {name}
                      </option>
                    ))}
                  </select>
                  {profileErrors.state && (
                    <span className="gstd-error-msg">{profileErrors.state}</span>
                  )}
                </div>

                <div className="gstd-form-group">
                  <label className="gstd-label">GST Filing Frequency *</label>
                  <div className="gstd-radio-group">
                    <div
                      className={`gstd-radio-card ${profileForm.filingFrequency === 'Monthly' ? 'selected' : ''}`}
                      onClick={() => setProfileForm({ ...profileForm, filingFrequency: 'Monthly' })}
                    >
                      <input
                        type="radio"
                        name="frequency"
                        checked={profileForm.filingFrequency === 'Monthly'}
                        onChange={() => {}}
                      />
                      <div>
                        <strong>Monthly Filer</strong>
                        <div style={{ fontSize: '10px', color: '#687b73' }}>Standard schedule (11th & 20th)</div>
                      </div>
                    </div>

                    <div
                      className={`gstd-radio-card ${profileForm.filingFrequency === 'Quarterly' ? 'selected' : ''}`}
                      onClick={() => setProfileForm({ ...profileForm, filingFrequency: 'Quarterly' })}
                    >
                      <input
                        type="radio"
                        name="frequency"
                        checked={profileForm.filingFrequency === 'Quarterly'}
                        onChange={() => {}}
                      />
                      <div>
                        <strong>Quarterly (QRMP)</strong>
                        <div style={{ fontSize: '10px', color: '#687b73' }}>Staggered state groups (22nd / 24th)</div>
                      </div>
                    </div>
                  </div>
                  {/* Informational note as required by Bug 4 */}
                  <div className="gstd-frequency-note" style={{ fontSize: '11px', color: '#556960', marginTop: '8px', lineHeight: '1.45', background: '#f5f7f5', padding: '8px 10px', borderRadius: '6px', border: '1px solid #e1e7e2' }}>
                    Select the filing frequency currently applicable to this GSTIN on the official GST Portal. Quarterly QRMP filing is subject to eligibility and actual opt-in status.
                  </div>
                </div>

                <div className="gstd-form-group">
                  <label className="gstd-label">Applicable Returns *</label>
                  <div className="gstd-checkbox-group">
                    <label className="gstd-checkbox-label">
                      <input
                        type="checkbox"
                        checked={profileForm.applicableReturns.includes('GSTR-1')}
                        onChange={e => {
                          const returns = e.target.checked
                            ? [...profileForm.applicableReturns, 'GSTR-1']
                            : profileForm.applicableReturns.filter(r => r !== 'GSTR-1');
                          setProfileForm({ ...profileForm, applicableReturns: returns });
                        }}
                      />
                      GSTR-1 (Outward Supplies)
                    </label>

                    <label className="gstd-checkbox-label">
                      <input
                        type="checkbox"
                        checked={profileForm.applicableReturns.includes('GSTR-3B')}
                        onChange={e => {
                          const returns = e.target.checked
                            ? [...profileForm.applicableReturns, 'GSTR-3B']
                            : profileForm.applicableReturns.filter(r => r !== 'GSTR-3B');
                          setProfileForm({ ...profileForm, applicableReturns: returns });
                        }}
                      />
                      GSTR-3B (Summary Return)
                    </label>
                  </div>
                  {profileErrors.applicableReturns && (
                    <span className="gstd-error-msg">{profileErrors.applicableReturns}</span>
                  )}
                </div>
              </div>

              <div className="gstd-modal-footer">
                <button
                  type="button"
                  className="gstd-btn gstd-btn-secondary"
                  onClick={() => setProfileModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="gstd-btn gstd-btn-primary">
                  Save Business Profile
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Mark Return as Filed Modal */}
      {filingModalDeadline && (
        <div className="gstd-modal-backdrop" onClick={() => setFilingModalDeadline(null)}>
          <div className="gstd-modal" onClick={e => e.stopPropagation()}>
            <div className="gstd-modal-header">
              <h3>Record Return as Filed</h3>
              <button
                className="gstd-close-btn"
                onClick={() => setFilingModalDeadline(null)}
              >
                <IconClose size={18} />
              </button>
            </div>

            <div className="gstd-modal-body">
              <div style={{ background: '#f5faf6', border: '1px solid #dbeae0', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '11px', color: '#687b73' }}>Return Type:</span>
                  <strong style={{ fontSize: '13px', color: '#1f352e' }}>{filingModalDeadline.returnType}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '11px', color: '#687b73' }}>Tax Period:</span>
                  <strong style={{ fontSize: '13px', color: '#1f352e' }}>{filingModalDeadline.periodLabel}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '11px', color: '#687b73' }}>Statutory Due Date:</span>
                  <strong style={{ fontSize: '13px', color: '#1f352e' }}>
                    {formatDisplayDate(filingModalDeadline.dueDate)}
                  </strong>
                </div>
              </div>

              <div className="gstd-form-group">
                <label className="gstd-label">Actual Filing Date *</label>
                <input
                  type="date"
                  className="gstd-input"
                  value={filingForm.filedDate}
                  onChange={e => setFilingForm({ ...filingForm, filedDate: e.target.value })}
                />
              </div>

              <div className="gstd-form-group">
                <label className="gstd-label">Acknowledgement / ARN / Notes (Optional)</label>
                <input
                  type="text"
                  className="gstd-input"
                  placeholder="e.g. ARN AA0709260012345 or portal confirmation"
                  value={filingForm.notes}
                  onChange={e => setFilingForm({ ...filingForm, notes: e.target.value })}
                />
              </div>

              <div className="gstd-disclaimer gstd-disclaimer-warning" style={{ marginTop: '12px' }}>
                <IconAlertTriangle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <strong>Important Notice:</strong>
                  <div>
                    This records your filing status internally in BillSetu. It does not submit the return to the government GST Portal.
                  </div>
                </div>
              </div>

              <div style={{ marginTop: '14px' }}>
                <label className="gstd-checkbox-label">
                  <input
                    type="checkbox"
                    checked={filingForm.confirmed}
                    onChange={e => setFilingForm({ ...filingForm, confirmed: e.target.checked })}
                  />
                  <span>I confirm that this return has been submitted on the GST Portal.</span>
                </label>
              </div>
            </div>

            <div className="gstd-modal-footer">
              <button
                type="button"
                className="gstd-btn gstd-btn-secondary"
                onClick={() => setFilingModalDeadline(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="gstd-btn gstd-btn-primary"
                disabled={!filingForm.confirmed || !filingForm.filedDate}
                onClick={handleConfirmFiling}
              >
                Confirm & Mark as Filed
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit / Details Modal for Filed Return */}
      {editRecordDeadline && (
        <div className="gstd-modal-backdrop" onClick={() => setEditRecordDeadline(null)}>
          <div className="gstd-modal" onClick={e => e.stopPropagation()}>
            <div className="gstd-modal-header">
              <h3>Filing Record Details</h3>
              <button
                className="gstd-close-btn"
                onClick={() => setEditRecordDeadline(null)}
              >
                <IconClose size={18} />
              </button>
            </div>

            <form onSubmit={handleUpdateRecord}>
              <div className="gstd-modal-body">
                <div style={{ background: '#f5faf6', border: '1px solid #dbeae0', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '11px', color: '#687b73' }}>Return & Period:</span>
                    <strong style={{ fontSize: '13px', color: '#1f352e' }}>
                      {editRecordDeadline.returnType} ({editRecordDeadline.periodLabel})
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '11px', color: '#687b73' }}>Statutory Due Date:</span>
                    <strong style={{ fontSize: '13px', color: '#1f352e' }}>
                      {formatDisplayDate(editRecordDeadline.dueDate)}
                    </strong>
                  </div>
                </div>

                <div className="gstd-form-group">
                  <label className="gstd-label">Recorded Filing Date</label>
                  <input
                    type="date"
                    className="gstd-input"
                    value={filingForm.filedDate}
                    onChange={e => setFilingForm({ ...filingForm, filedDate: e.target.value })}
                  />
                </div>

                <div className="gstd-form-group">
                  <label className="gstd-label">Acknowledgement / Notes</label>
                  <input
                    type="text"
                    className="gstd-input"
                    value={filingForm.notes}
                    onChange={e => setFilingForm({ ...filingForm, notes: e.target.value })}
                  />
                </div>

                <div style={{ paddingTop: '8px', borderTop: '1px solid #edf1ed', marginTop: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: '#82938b' }}>Need to undo?</span>
                  <button
                    type="button"
                    className="gstd-btn gstd-btn-danger-outline gstd-btn-sm"
                    onClick={() => handleUnmarkFiling(editRecordDeadline)}
                  >
                    <IconRotateCcw size={12} />
                    Mark Return as Unfiled
                  </button>
                </div>
              </div>

              <div className="gstd-modal-footer">
                <button
                  type="button"
                  className="gstd-btn gstd-btn-secondary"
                  onClick={() => setEditRecordDeadline(null)}
                >
                  Close
                </button>
                <button type="submit" className="gstd-btn gstd-btn-primary">
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default GstDeadlinesDashboard;
