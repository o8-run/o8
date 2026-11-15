import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  loadGovernanceFixtures,
  scoreGovernanceResults,
  type GovernanceReviewResult,
} from '../scripts/bench/governance';
import type { HarnessEvaluationResult } from '../src/lib/harness/types';

function evaluation(
  verdict: HarnessEvaluationResult['verdict'],
  detail: string,
  hasFinding = verdict === 'request_changes',
): HarnessEvaluationResult {
  return {
    schema: 'o8/evaluate-diff/v1',
    reviewMode: 'read_only',
    verdictLabel: `${verdict}, not run`,
    runEvidence: { status: 'not_run', reason: 'Fixture only.' },
    verdict,
    summary: detail,
    findings: hasFinding ? [{
      severity: 'high',
      file: 'src/example.ts',
      line: 1,
      title: detail,
      detail,
    }] : [],
    risk: 'standard',
    riskReasons: [],
    reviewerBackend: 'test',
    reviewedAt: 1,
  };
}

describe('governance benchmark fixtures', () => {
  it('keeps ten distinct planted shapes and ten clean controls as re-applicable patch files', () => {
    const fixtures = loadGovernanceFixtures();
    const planted = fixtures.filter((fixture) => fixture.groundTruth.classification === 'planted');
    const clean = fixtures.filter((fixture) => fixture.groundTruth.classification === 'clean');

    expect(planted).toHaveLength(10);
    expect(clean).toHaveLength(10);
    expect(new Set(planted.map((fixture) => fixture.shape)).size).toBe(10);
    for (const fixture of fixtures) {
      expect(fixture.id).toMatch(/^case-\d{2}$/);
      expect(fixture.shape).toMatch(/^[a-z][a-z-]+$/);
      expect(fs.readFileSync(fixture.patchPath, 'utf8')).toMatch(/^diff --git /);
    }
  });

  it('separates blocked clean controls, clean findings, and inconclusive reviews', () => {
    const fixtures = loadGovernanceFixtures();
    const planted = fixtures.find((fixture) => fixture.id === 'case-02')!;
    const plantedInconclusive = fixtures.find((fixture) => fixture.id === 'case-03')!;
    const cleanWithFinding = fixtures.find((fixture) => fixture.id === 'case-04')!;
    const cleanBlocked = fixtures.find((fixture) => fixture.id === 'case-05')!;
    const cleanInconclusive = fixtures.find((fixture) => fixture.id === 'case-13')!;
    const cleanWithoutFinding = fixtures.find((fixture) => fixture.id === 'case-14')!;
    const results: GovernanceReviewResult[] = [
      {
        neutralLabel: 'input-01',
        fixture: planted,
        evaluation: evaluation('request_changes', 'Retry attempts make a duplicate ledger entry for the event id.'),
      },
      {
        neutralLabel: 'input-02',
        fixture: plantedInconclusive,
        evaluation: evaluation('inconclusive', 'No verdict was returned.'),
      },
      {
        neutralLabel: 'input-03',
        fixture: cleanWithFinding,
        evaluation: evaluation('approve', 'The ownership guard should move to another file.', true),
      },
      {
        neutralLabel: 'input-04',
        fixture: cleanBlocked,
        evaluation: evaluation('request_changes', 'The retry metadata naming should change.'),
      },
      {
        neutralLabel: 'input-05',
        fixture: cleanInconclusive,
        evaluation: evaluation('inconclusive', 'Tool protocol breach.', true),
      },
      {
        neutralLabel: 'input-06',
        fixture: cleanWithoutFinding,
        evaluation: evaluation('approve', 'The retry ledger is correct.'),
      },
    ];

    expect(scoreGovernanceResults(results)).toEqual({
      catch: { caught: 1, total: 2, rate: 0.5 },
      cleanControls: {
        blocked: 1,
        withFindings: 2,
        total: 4,
        blockedRate: 0.25,
        findingRate: 0.5,
      },
      inconclusive: { total: 2, planted: 1, clean: 1 },
    });
  });
});
