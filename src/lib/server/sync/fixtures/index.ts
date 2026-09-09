/**
 * Synthetic API fixtures and compatibility boundary specifications
 * for the Work Times sync engine (Milestone P0).
 *
 * Each fixture models an upstream API response shape or reconciliation scenario,
 * documenting and freezing the compatibility rules specified in docs/NEXT-MILESTONE.md §2, 3, 6.
 *
 * Invariants preserved:
 * - Never infer heartbeat duration or derive elapsed time from heartbeat timestamps.
 * - Never expand work time or classify coarse project totals automatically.
 * - Never silently default missing entity detail arrays to complete empty arrays.
 * - Distinguish missing requested date from complete verified zero.
 * - Capture positive residuals even below one second into unattributed residual slices.
 * - Reject overcounts exceeding 0.001s tolerance; never clamp away discrepancies.
 * - Enforce CAS on connection generations to protect reconnected accounts.
 * - Reject unsupported heartbeat IDs, envelopes, and dependency structures with safe codes.
 */

// ============================================================================
// 1. Flat Project Totals with Missing Entity Detail
// ============================================================================

export const FLAT_PROJECT_SUMMARY_RAW = {
  data: [
    {
      date: '2026-09-08',
      range: {
        date: '2026-09-08',
        start: '2026-09-08T00:00:00Z',
        end: '2026-09-08T23:59:59Z',
        text: 'Tue Sep 8th 2026',
        timezone: 'Europe/London'
      },
      grand_total: {
        total_seconds: 14400.0,
        human_additions: 120,
        human_deletions: 30,
        ai_additions: 0,
        ai_deletions: 0,
        ai_sessions: 0
      },
      // Flat project totals: projects have total_seconds, but NO entities arrays!
      projects: [
        {
          name: 'work-times',
          total_seconds: 10800.0,
          percent: 75.0
        },
        {
          name: 'personal-blog',
          total_seconds: 3600.0,
          percent: 25.0
        }
      ]
    }
  ],
  start: '2026-09-08T00:00:00Z',
  end: '2026-09-08T23:59:59Z'
} as const;

export const FLAT_PROJECT_SUMMARY_FIXTURE = {
  id: 'flat_project_summary',
  description:
    'Complete daily summary with project totals but omitted entity breakdown arrays. Must yield coarse project_summary slices and unclassified state by default.',
  rawPayload: FLAT_PROJECT_SUMMARY_RAW,
  date: '2026-09-08',
  timezone: 'Europe/London',
  expectedFidelity: 'coarse_project' as const,
  expectedCompleteness: {
    hasAccountTotals: true,
    hasProjectTotals: true,
    hasEntityDetail: false,
    isVerifiedZero: false,
    overallEntityDetailState: 'coarse_only' as const,
    projectScopes: {
      'work-times': {
        projectName: 'work-times',
        totalSeconds: 10800.0,
        entityDetailState: 'absent' as const,
        entityCount: 0
      },
      'personal-blog': {
        projectName: 'personal-blog',
        totalSeconds: 3600.0,
        entityDetailState: 'absent' as const,
        entityCount: 0
      }
    },
    missingFields: []
  },
  expectedSliceCount: 2,
  expectedSliceKinds: ['project_summary', 'project_summary'] as const
};

// ============================================================================
// 2. Verified Zero Day
// ============================================================================

export const VERIFIED_ZERO_DAY_RAW = {
  data: [
    {
      date: '2026-09-07',
      range: {
        date: '2026-09-07',
        start: '2026-09-07T00:00:00Z',
        end: '2026-09-07T23:59:59Z',
        text: 'Mon Sep 7th 2026',
        timezone: 'Europe/London'
      },
      grand_total: {
        total_seconds: 0.0,
        human_additions: 0,
        human_deletions: 0,
        ai_additions: 0,
        ai_deletions: 0,
        ai_sessions: 0
      },
      projects: []
    }
  ],
  start: '2026-09-07T00:00:00Z',
  end: '2026-09-07T23:59:59Z',
  cumulative_total: { seconds: 0.0, text: '0 secs' }
} as const;

export const VERIFIED_ZERO_DAY_FIXTURE = {
  id: 'verified_zero_day',
  description:
    'Authoritative zero-duration day. Complete response with total_seconds = 0 and empty projects array.',
  rawPayload: VERIFIED_ZERO_DAY_RAW,
  date: '2026-09-07',
  timezone: 'Europe/London',
  expectedFidelity: 'verified_zero' as const,
  expectedCompleteness: {
    hasAccountTotals: true,
    hasProjectTotals: true,
    hasEntityDetail: true,
    isVerifiedZero: true,
    overallEntityDetailState: 'empty' as const,
    projectScopes: {},
    missingFields: []
  },
  expectedSliceCount: 0
};

// ============================================================================
// 3. Missing Requested Date
// ============================================================================

export const MISSING_REQUESTED_DATE_RAW = {
  // Upstream returns empty data array or dates other than the one queried
  data: [],
  start: '2026-09-06T00:00:00Z',
  end: '2026-09-06T23:59:59Z'
} as const;

export const MISSING_REQUESTED_DATE_FIXTURE = {
  id: 'missing_requested_date',
  description:
    'API response where the queried date is absent from the data array. Must NOT be treated as zero.',
  rawPayload: MISSING_REQUESTED_DATE_RAW,
  requestedDate: '2026-09-06',
  expectedReconcileDisposition: 'rejected' as const,
  expectedDayStatus: 'failed' as const,
  expectedCode: 'MISSING_REQUESTED_DATE'
};

// ============================================================================
// 4. Incomplete Body
// ============================================================================

export const INCOMPLETE_BODY_RAW =
  '{"data":[{"date":"2026-09-05","grand_total":{"total_seconds":3600.0}' as const; // truncated JSON

export const INCOMPLETE_BODY_MISSING_FIELDS_RAW = {
  data: [
    {
      date: '2026-09-05'
      // Missing grand_total, range, etc.
    }
  ]
} as const;

export const INCOMPLETE_BODY_FIXTURE = {
  id: 'incomplete_body',
  description:
    'Truncated response or missing mandatory grand_total structure. Must fail closed and retain existing archive.',
  rawPayload: INCOMPLETE_BODY_RAW,
  missingFieldsPayload: INCOMPLETE_BODY_MISSING_FIELDS_RAW,
  expectedCode: 'INCOMPLETE_BODY',
  expectedDayStatus: 'failed' as const,
  expectedReconcileDisposition: 'rejected' as const
};

// ============================================================================
// 5. Detail Downgrade
// ============================================================================

export const DETAIL_DOWNGRADE_SCENARIO = {
  id: 'detail_downgrade',
  description:
    'Incoming coarse summary polled for a date that already has full file-level entity detail in archive. Must preserve archive detail and record DETAIL_DOWNGRADE.',
  existingAcceptedDay: {
    date: '2026-09-04',
    timezone: 'Europe/London',
    fidelity: 'entity_detail' as const,
    totalSeconds: 7200.0,
    slices: [
      {
        entity: '/src/index.ts',
        entityType: 'file' as const,
        projectName: 'work-times',
        totalSeconds: 5000.0,
        kind: 'entity' as const
      },
      {
        entity: '/src/lib/server.ts',
        entityType: 'file' as const,
        projectName: 'work-times',
        totalSeconds: 2200.0,
        kind: 'entity' as const
      }
    ]
  },
  incomingObservation: {
    date: '2026-09-04',
    timezone: 'Europe/London',
    fidelity: 'coarse_project' as const,
    totalSeconds: 7200.0,
    projects: [
      {
        name: 'work-times',
        totalSeconds: 7200.0
        // No entities detail
      }
    ]
  },
  expectedReconcileDisposition: 'preserved' as const,
  expectedDayStatus: 'partial' as const,
  expectedCode: 'DETAIL_DOWNGRADE'
};

// ============================================================================
// 6. Unsupported Heartbeat IDs, Envelopes, and Dependencies
// ============================================================================

export const UNSUPPORTED_HEARTBEATS_RAW = {
  // Case A: non-UUID / malformed heartbeat id
  invalidId: {
    id: 'invalid-non-uuid-1234',
    entity: '/src/app.ts',
    type: 'file',
    time: 1725876000.0
  },
  // Case B: invalid dependency format (objects instead of string array)
  invalidDependencies: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    entity: '/src/app.ts',
    type: 'file',
    time: 1725876000.0,
    dependencies: [{ name: 'svelte' }] // invalid type, must be string[]
  },
  // Case C: invalid envelope (data is not an array)
  invalidEnvelope: {
    data: 'not-an-array',
    start: '2026-09-03T00:00:00Z',
    end: '2026-09-03T23:59:59Z'
  },
  // Case D: payload conflict (same external_id but conflicting entity/time)
  conflictBase: {
    id: '550e8400-e29b-41d4-a716-446655440001',
    entity: '/src/original.ts',
    type: 'file',
    time: 1725876100.0
  },
  conflictVariant: {
    id: '550e8400-e29b-41d4-a716-446655440001',
    entity: '/src/conflicting.ts', // different entity!
    type: 'file',
    time: 1725876100.0
  }
} as const;

export const UNSUPPORTED_HEARTBEATS_FIXTURE = {
  id: 'unsupported_heartbeats',
  description:
    'Heartbeat payloads violating UUID, envelope, dependency array types, or conflicting payload variants. Must fail layer with bounded compatibility codes.',
  samples: UNSUPPORTED_HEARTBEATS_RAW,
  expectedCodes: {
    invalidId: 'UNSUPPORTED_HEARTBEAT_ID',
    invalidDependencies: 'UNSUPPORTED_HEARTBEAT_DEPENDENCY',
    invalidEnvelope: 'UNSUPPORTED_HEARTBEAT_ENVELOPE',
    conflict: 'HEARTBEAT_PAYLOAD_CONFLICT'
  }
};

// ============================================================================
// 7. Registry Pagination Ambiguity, Repetition, and Conflict
// ============================================================================

export const REGISTRY_PAGINATION_RAW = {
  // Page repetition loop
  repetitionPage1: {
    page: 1,
    total: 2,
    total_pages: 2,
    next_page: 2,
    data: [
      {
        id: '990e8400-e29b-41d4-a716-446655440001',
        value: 'wakatime/v1.0.0 (Darwin) VSCode/1.90.0',
        editor: 'VS Code',
        os: 'Mac'
      }
    ]
  },
  repetitionPage2: {
    page: 2,
    total: 2,
    total_pages: 2,
    next_page: 1, // Loop pointing back to page 1!
    data: [
      {
        id: '990e8400-e29b-41d4-a716-446655440001', // Repeated ID from page 1
        value: 'wakatime/v1.0.0 (Darwin) VSCode/1.90.0',
        editor: 'VS Code',
        os: 'Mac'
      }
    ]
  },
  // Conflicting ID across pages
  conflictingPage2: {
    page: 2,
    total: 2,
    total_pages: 2,
    next_page: null,
    data: [
      {
        id: '990e8400-e29b-41d4-a716-446655440001', // Same UUID as page 1
        value: 'cursor/v2.0.0 (Darwin) Cursor/0.40.0',
        editor: 'Cursor', // Contradictory editor identity!
        os: 'Mac'
      }
    ]
  },
  // Inconsistent pagination numbers
  invalidPaginationNumbers: {
    page: 2,
    total: 1,
    total_pages: 1, // page > total_pages
    data: []
  }
} as const;

export const REGISTRY_PAGINATION_FIXTURE = {
  id: 'registry_pagination',
  description:
    'User-agent registry pagination anomalies. Stage must detect repetition/conflict and abort whole refresh without publishing partial state.',
  samples: REGISTRY_PAGINATION_RAW,
  expectedCodes: {
    repetition: 'REGISTRY_PAGE_REPETITION',
    conflict: 'REGISTRY_CONFLICTING_ID',
    invalidEnvelope: 'REGISTRY_INVALID_PAGINATION'
  }
};

// ============================================================================
// 8. Timezone Mismatch
// ============================================================================

export const TIMEZONE_MISMATCH_RAW = {
  data: [
    {
      date: '2026-09-02',
      range: {
        date: '2026-09-02',
        timezone: 'America/New_York' // Account pinned timezone is Europe/London
      },
      grand_total: { total_seconds: 3600.0 },
      projects: [{ name: 'work-times', total_seconds: 3600.0 }]
    }
  ]
} as const;

export const TIMEZONE_MISMATCH_FIXTURE = {
  id: 'timezone_mismatch',
  description:
    'Summary response whose range timezone disagrees with the verified pinned account timezone. Must pause acceptance.',
  rawPayload: TIMEZONE_MISMATCH_RAW,
  accountTimezone: 'Europe/London',
  expectedCode: 'TIMEZONE_MISMATCH',
  expectedDayStatus: 'failed' as const,
  expectedReconcileDisposition: 'rejected' as const
};

// ============================================================================
// 9. Overcount Exceeding Mathematical Tolerance
// ============================================================================

export const OVERCOUNT_DAY_RAW = {
  data: [
    {
      date: '2026-09-01',
      range: { date: '2026-09-01', timezone: 'UTC' },
      grand_total: { total_seconds: 3600.0 },
      // Projects sum to 3605.0 seconds (overcount of 5.0s > 0.001s tolerance)
      projects: [
        { name: 'project-a', total_seconds: 2000.0 },
        { name: 'project-b', total_seconds: 1605.0 }
      ]
    }
  ]
} as const;

export const OVERCOUNT_DAY_FIXTURE = {
  id: 'overcount_day',
  description:
    'Summary where sum of project totals exceeds grand_total beyond 0.001s tolerance. Must reject candidate and never clamp.',
  rawPayload: OVERCOUNT_DAY_RAW,
  tolerance: 0.001,
  discrepancySeconds: 5.0,
  expectedCode: 'OVERCOUNT_TOLERANCE_EXCEEDED',
  expectedDayStatus: 'failed' as const,
  expectedReconcileDisposition: 'rejected' as const
};

// ============================================================================
// 10. Tiny Positive Residual Captured in Unattributed Slice
// ============================================================================

export const TINY_RESIDUAL_DAY_RAW = {
  data: [
    {
      date: '2026-08-31',
      range: { date: '2026-08-31', timezone: 'UTC' },
      grand_total: { total_seconds: 3600.005 },
      // Projects sum to 3600.000; residual is positive +0.005s
      projects: [{ name: 'project-a', total_seconds: 3600.0 }]
    }
  ]
} as const;

export const TINY_RESIDUAL_DAY_FIXTURE = {
  id: 'tiny_positive_residual',
  description:
    'Summary where grand_total exceeds sum of projects by 0.005s. Positive residual must be retained in an __unattributed__ residual slice.',
  rawPayload: TINY_RESIDUAL_DAY_RAW,
  expectedProjectSeconds: 3600.0,
  expectedResidualSeconds: 0.005,
  expectedUnattributedSlice: {
    entity: '__unattributed__',
    entityType: 'unattributed' as const,
    isUnattributed: 1,
    totalSeconds: 0.005
  }
};

// ============================================================================
// 11. Connection Generation CAS Guard
// ============================================================================

export const CONNECTION_GENERATION_SCENARIO = {
  id: 'connection_generation',
  description:
    'Concurrent or late token refresh/persistence guard. Prevents stale worker operating under generation N from overwriting connection generation N+1.',
  activeConnection: {
    id: 1,
    generation: 2,
    connectedAt: '2026-09-08T15:00:00Z',
    updatedAt: '2026-09-08T15:00:00Z'
  },
  staleWorkerCandidate: {
    assumedGeneration: 1, // Stale!
    newAccessTokenSealed: 'encrypted_stale_token',
    newRefreshTokenSealed: 'encrypted_stale_refresh'
  },
  validWorkerCandidate: {
    assumedGeneration: 2, // Matches active!
    newAccessTokenSealed: 'encrypted_fresh_token',
    newRefreshTokenSealed: 'encrypted_fresh_refresh'
  },
  expectedStaleCode: 'STALE_CONNECTION_GENERATION'
};

// ============================================================================
// Consolidated Fixtures Registry
// ============================================================================

export const SYNTHETIC_FIXTURES = {
  flatProjectSummary: FLAT_PROJECT_SUMMARY_FIXTURE,
  verifiedZeroDay: VERIFIED_ZERO_DAY_FIXTURE,
  missingRequestedDate: MISSING_REQUESTED_DATE_FIXTURE,
  incompleteBody: INCOMPLETE_BODY_FIXTURE,
  detailDowngrade: DETAIL_DOWNGRADE_SCENARIO,
  unsupportedHeartbeats: UNSUPPORTED_HEARTBEATS_FIXTURE,
  registryPagination: REGISTRY_PAGINATION_FIXTURE,
  timezoneMismatch: TIMEZONE_MISMATCH_FIXTURE,
  overcountDay: OVERCOUNT_DAY_FIXTURE,
  tinyPositiveResidual: TINY_RESIDUAL_DAY_FIXTURE,
  connectionGeneration: CONNECTION_GENERATION_SCENARIO
} as const;
