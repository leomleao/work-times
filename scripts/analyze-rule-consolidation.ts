#!/usr/bin/env tsx
/**
 * Analyze rule consolidation impact before applying changes.
 *
 * Usage:
 *   pnpm rules:analyze --db <path> --manifest <manifest-path> [--json] [--out <output-path>]
 *
 * Safety Constraints:
 *   - The CLI requires --db <path> explicitly and opens it strictly read-only with migrate: false.
 *   - It never defaults to live or hardcoded database paths.
 *   - Manifest schema is strictly validated against allowed keys, pattern lengths, and selector types.
 *   - Zero mutations are performed on the target database.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../src/lib/server/db/connection.js';
import {
  SqliteClassificationService
} from '../src/lib/server/classification/sqlite.js';
import {
  classifySlice,
  type ClassificationRule,
  type ClassificationDecision,
  type Classification,
  type MatchMode,
  type SelectorType
} from '../src/lib/server/classification/model.js';
import {
  validateManifest,
  type ConsolidationManifest
} from './consolidate-rules.js';

export interface AnalysisCliArgs {
  dbPath: string | null;
  manifestPath: string | null;
  outPath: string | null;
  json: boolean;
}

export interface RuleConsolidationAnalysisResult {
  totalSlices: number;
  totalSeconds: number;
  hardGatePassed: boolean;
  unintendedFlipsCount: number;
  unintendedFlips: Array<{
    sliceId: number;
    date: string;
    entity: string;
    from: Classification;
    to: Classification;
  }>;
  ambiguityTransitionsCount: number;
  baseline: {
    ruleCount: number;
    workSlices: number;
    personalSlices: number;
    unclassifiedSlices: number;
    workSeconds: number;
    personalSeconds: number;
    unclassifiedSeconds: number;
    coveragePercent: number;
  };
  proposed: {
    ruleCount: number;
    retiredCount: number;
    createdCount: number;
    workSlices: number;
    personalSlices: number;
    unclassifiedSlices: number;
    workSeconds: number;
    personalSeconds: number;
    unclassifiedSeconds: number;
    coveragePercent: number;
  };
  netGains: {
    additionalClassifiedSlices: number;
    additionalClassifiedSeconds: number;
    coverageDeltaPercent: number;
  };
  transitions: Record<string, { count: number; seconds: number }>;
}

export function parseAnalysisArguments(argv: readonly string[]): AnalysisCliArgs {
  const args: AnalysisCliArgs = {
    dbPath: null,
    manifestPath: null,
    outPath: null,
    json: false
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--database':
      case '--db': {
        const next = argv[++i];
        if (!next) throw new Error(`${flag} requires a database path`);
        args.dbPath = next;
        break;
      }
      case '--manifest': {
        const next = argv[++i];
        if (!next) throw new Error(`${flag} requires a manifest path`);
        args.manifestPath = next;
        break;
      }
      case '--out':
      case '--output': {
        const next = argv[++i];
        if (!next) throw new Error(`${flag} requires an output path`);
        args.outPath = next;
        break;
      }
      case '--json': {
        args.json = true;
        break;
      }
      case '--help':
      case '-h': {
        process.stdout.write(
          'Usage:\n' +
            '  pnpm rules:analyze --db <path> --manifest <manifest-path> [--json] [--out <output-path>]\n\n' +
            'Options:\n' +
            '  --db, --database   Path to target SQLite database (required)\n' +
            '  --manifest         Path to consolidation manifest JSON (required)\n' +
            '  --out, --output    Optional path to write JSON analysis output\n' +
            '  --json             Print output as JSON\n' +
            '  -h, --help         Show this help message\n'
        );
        process.exit(0);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

export function runRuleConsolidationAnalysis(
  dbPath: string,
  manifest: ConsolidationManifest
): RuleConsolidationAnalysisResult {
  const resolvedDbPath = resolve(process.cwd(), dbPath);
  const db = openDatabase({
    path: resolvedDbPath,
    readonly: true,
    migrate: false,
    wal: false
  });

  try {
    const service = new SqliteClassificationService(db);
    const columns = db.prepare(`PRAGMA table_info(classification_rules)`).all() as Array<{ name: string }>;
    const hasMatchMode = columns.some((c) => c.name === 'match_mode');

    const selectSql = hasMatchMode
      ? `SELECT id, classification, selector_type, selector_value, match_mode, priority, enabled, created_at FROM classification_rules ORDER BY id ASC`
      : `SELECT id, classification, selector_type, selector_value, 'exact' AS match_mode, priority, enabled, created_at FROM classification_rules ORDER BY id ASC`;

    const existingRules = db.prepare(selectSql).all() as Array<{
      id: string;
      classification: 'work' | 'personal';
      selector_type: SelectorType;
      selector_value: string;
      match_mode: MatchMode;
      priority: number;
      enabled: number | boolean;
      created_at: string;
    }>;
    const existingRuleMap = new Map(existingRules.map((r) => [r.id, r]));

    // Validate that all deleteRuleIds exist in target database
    if (manifest.deleteRuleIds && manifest.deleteRuleIds.length > 0) {
      for (const id of manifest.deleteRuleIds) {
        if (!existingRuleMap.has(id)) {
          throw new Error(
            `Rule '${id}' specified in deleteRuleIds does not exist in target database`
          );
        }
      }
    }

    const baselineModelRules: ClassificationRule[] = existingRules.map((r) => ({
      id: r.id,
      classification: r.classification,
      selectorType: r.selector_type,
      selectorValue: r.selector_value,
      matchMode: r.match_mode || 'exact',
      priority: r.priority,
      enabled: Boolean(r.enabled),
      createdAt: r.created_at
    }));

    const deleteSet = new Set(manifest.deleteRuleIds ?? []);

    // Construct proposed ruleset
    const retainedRules = baselineModelRules.filter((r) => !deleteSet.has(r.id));
    const createdRules: ClassificationRule[] = (manifest.createRules ?? []).map((cr, idx) => ({
      id: cr.id ?? `proposed-created-rule-${idx + 1}`,
      classification: cr.classification,
      selectorType: cr.selectorType,
      selectorValue: cr.selectorValue,
      matchMode: cr.matchMode || 'exact',
      priority: cr.priority ?? 0,
      enabled: true,
      createdAt: new Date().toISOString()
    }));

    const proposedModelRules: ClassificationRule[] = [...retainedRules, ...createdRules];

    const rawSlices = service.loadSlicesWithContext();

    let baselineWorkSec = 0, baselinePersonalSec = 0, baselineUnclassifiedSec = 0;
    let proposedWorkSec = 0, proposedPersonalSec = 0, proposedUnclassifiedSec = 0;

    let baselineWorkCount = 0, baselinePersonalCount = 0, baselineUnclassifiedCount = 0;
    let proposedWorkCount = 0, proposedPersonalCount = 0, proposedUnclassifiedCount = 0;

    let unintendedFlipsCount = 0;
    const unintendedFlips: Array<{
      sliceId: number;
      date: string;
      entity: string;
      from: Classification;
      to: Classification;
    }> = [];

    let ambiguityTransitionsCount = 0;
    const transitions: Record<string, { count: number; seconds: number }> = {};

    for (const item of rawSlices) {
      const override = item.allocation ? { classification: item.allocation.classification } : null;

      let baseDecision: ClassificationDecision;
      if (item.isUnattributed) {
        baseDecision = override
          ? { classification: override.classification, source: 'override', winningRuleId: null, competingRuleIds: [] }
          : { classification: 'unclassified', source: 'default', winningRuleId: null, competingRuleIds: [] };
      } else {
        baseDecision = classifySlice(item.classifiableSlice, baselineModelRules, override);
      }

      let propDecision: ClassificationDecision;
      if (item.isUnattributed) {
        propDecision = override
          ? { classification: override.classification, source: 'override', winningRuleId: null, competingRuleIds: [] }
          : { classification: 'unclassified', source: 'default', winningRuleId: null, competingRuleIds: [] };
      } else {
        propDecision = classifySlice(item.classifiableSlice, proposedModelRules, override);
      }

      const sec = item.totalSeconds;
      if (baseDecision.classification === 'work') {
        baselineWorkSec += sec;
        baselineWorkCount++;
      } else if (baseDecision.classification === 'personal') {
        baselinePersonalSec += sec;
        baselinePersonalCount++;
      } else {
        baselineUnclassifiedSec += sec;
        baselineUnclassifiedCount++;
      }

      if (propDecision.classification === 'work') {
        proposedWorkSec += sec;
        proposedWorkCount++;
      } else if (propDecision.classification === 'personal') {
        proposedPersonalSec += sec;
        proposedPersonalCount++;
      } else {
        proposedUnclassifiedSec += sec;
        proposedUnclassifiedCount++;
      }

      if (baseDecision.classification !== propDecision.classification) {
        const transKey = `${baseDecision.classification}->${propDecision.classification}`;
        if (!transitions[transKey]) {
          transitions[transKey] = { count: 0, seconds: 0 };
        }
        transitions[transKey].count++;
        transitions[transKey].seconds += sec;

        if (
          (baseDecision.classification === 'work' && propDecision.classification === 'personal') ||
          (baseDecision.classification === 'personal' && propDecision.classification === 'work')
        ) {
          unintendedFlipsCount++;
          unintendedFlips.push({
            sliceId: item.id,
            date: item.date,
            entity: item.entity,
            from: baseDecision.classification,
            to: propDecision.classification
          });
        }
      } else if (baseDecision.source !== propDecision.source || baseDecision.winningRuleId !== propDecision.winningRuleId) {
        const transKey = `same_classification:${baseDecision.source}->${propDecision.source}`;
        if (!transitions[transKey]) {
          transitions[transKey] = { count: 0, seconds: 0 };
        }
        transitions[transKey].count++;
        transitions[transKey].seconds += sec;
      }

      if (
        (baseDecision.source === 'ambiguous' && propDecision.source !== 'ambiguous') ||
        (baseDecision.source !== 'ambiguous' && propDecision.source === 'ambiguous')
      ) {
        ambiguityTransitionsCount++;
      }
    }

    const totalSec = baselineWorkSec + baselinePersonalSec + baselineUnclassifiedSec;
    const baselineCoverage = totalSec > 0 ? ((baselineWorkSec + baselinePersonalSec) / totalSec) * 100 : 0;
    const proposedCoverage = totalSec > 0 ? ((proposedWorkSec + proposedPersonalSec) / totalSec) * 100 : 0;

    return {
      totalSlices: rawSlices.length,
      totalSeconds: totalSec,
      hardGatePassed: unintendedFlipsCount === 0,
      unintendedFlipsCount,
      unintendedFlips,
      ambiguityTransitionsCount,
      baseline: {
        ruleCount: baselineModelRules.length,
        workSlices: baselineWorkCount,
        personalSlices: baselinePersonalCount,
        unclassifiedSlices: baselineUnclassifiedCount,
        workSeconds: baselineWorkSec,
        personalSeconds: baselinePersonalSec,
        unclassifiedSeconds: baselineUnclassifiedSec,
        coveragePercent: baselineCoverage
      },
      proposed: {
        ruleCount: proposedModelRules.length,
        retiredCount: deleteSet.size,
        createdCount: createdRules.length,
        workSlices: proposedWorkCount,
        personalSlices: proposedPersonalCount,
        unclassifiedSlices: proposedUnclassifiedCount,
        workSeconds: proposedWorkSec,
        personalSeconds: proposedPersonalSec,
        unclassifiedSeconds: proposedUnclassifiedSec,
        coveragePercent: proposedCoverage
      },
      netGains: {
        additionalClassifiedSlices:
          proposedWorkCount + proposedPersonalCount - (baselineWorkCount + baselinePersonalCount),
        additionalClassifiedSeconds:
          proposedWorkSec + proposedPersonalSec - (baselineWorkSec + baselinePersonalSec),
        coverageDeltaPercent: proposedCoverage - baselineCoverage
      },
      transitions
    };
  } finally {
    db.close();
  }
}

export async function executeAnalysisCli(argv: readonly string[]): Promise<number> {
  const args = parseAnalysisArguments(argv);

  if (!args.dbPath) {
    throw new Error('Missing required argument: --database <path>');
  }
  if (!args.manifestPath) {
    throw new Error('Missing required argument: --manifest <path>');
  }

  const resolvedManifestPath = resolve(process.cwd(), args.manifestPath);
  const rawManifest = JSON.parse(readFileSync(resolvedManifestPath, 'utf8'));
  const manifest = validateManifest(rawManifest);

  const result = runRuleConsolidationAnalysis(args.dbPath, manifest);

  if (args.outPath) {
    const resolvedOutPath = resolve(process.cwd(), args.outPath);
    writeFileSync(resolvedOutPath, JSON.stringify(result, null, 2), 'utf8');
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write('=== Rule Consolidation Impact Analysis ===\n');
    process.stdout.write(`Database: ${args.dbPath}\n`);
    process.stdout.write(`Manifest: ${args.manifestPath}\n`);
    process.stdout.write(`Total Historical Slices: ${result.totalSlices}\n`);
    process.stdout.write(`Rules: ${result.baseline.ruleCount} -> ${result.proposed.ruleCount} (-${result.proposed.retiredCount} retired, +${result.proposed.createdCount} created)\n\n`);

    process.stdout.write(`Hard Gate Status: ${result.hardGatePassed ? 'PASSED (0 unintended flips)' : `FAILED (${result.unintendedFlipsCount} unintended flips)`}\n`);
    process.stdout.write(`Ambiguity Transitions: ${result.ambiguityTransitionsCount}\n\n`);

    process.stdout.write('--- Coverage Comparison ---\n');
    process.stdout.write(
      `Baseline: Work ${result.baseline.workSlices} (${(result.baseline.workSeconds / 3600).toFixed(1)}h), ` +
      `Personal ${result.baseline.personalSlices} (${(result.baseline.personalSeconds / 3600).toFixed(1)}h), ` +
      `Unclassified ${result.baseline.unclassifiedSlices} (${(result.baseline.unclassifiedSeconds / 3600).toFixed(1)}h) -> ` +
      `${result.baseline.coveragePercent.toFixed(4)}% coverage\n`
    );
    process.stdout.write(
      `Proposed: Work ${result.proposed.workSlices} (${(result.proposed.workSeconds / 3600).toFixed(1)}h), ` +
      `Personal ${result.proposed.personalSlices} (${(result.proposed.personalSeconds / 3600).toFixed(1)}h), ` +
      `Unclassified ${result.proposed.unclassifiedSlices} (${(result.proposed.unclassifiedSeconds / 3600).toFixed(1)}h) -> ` +
      `${result.proposed.coveragePercent.toFixed(4)}% coverage\n`
    );
    process.stdout.write(
      `Net Gains: +${result.netGains.additionalClassifiedSlices} slices, ` +
      `+${(result.netGains.additionalClassifiedSeconds / 3600).toFixed(2)} hrs, ` +
      `+${result.netGains.coverageDeltaPercent.toFixed(4)}% coverage\n`
    );
  }

  return result.hardGatePassed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  executeAnalysisCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
