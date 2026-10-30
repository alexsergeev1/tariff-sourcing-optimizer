import assert from "node:assert/strict";
import test from "node:test";
import { runStudy } from "./engine.mjs";

const close = (actual, expected, tolerance = 1e-6) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `expected ${actual} to be within ${tolerance} of ${expected}`,
);

test("all plans balance demand and satisfy shared qualification and capital limits", () => {
  const study = runStudy({ qualificationBudget: 1_200_000, workingCapitalBudget: 1_100_000, qualificationSlots: 3, maxStartsPerQuarter: 1, includeSensitivity: false });
  assert.equal(study.components.length, 10);
  for (const strategy of Object.values(study.strategies)) {
    assert.ok(strategy.qualificationCost <= study.config.qualificationBudget);
    assert.ok(strategy.budgetedWorkingCapital <= study.config.workingCapitalBudget);
    assert.ok(strategy.workingCapital <= strategy.budgetedWorkingCapital);
    assert.ok(strategy.qualificationSlots <= study.config.qualificationSlots);
    assert.ok(strategy.qualificationStarts.every((count) => count <= study.config.maxStartsPerQuarter));
    for (const part of strategy.allocations) {
      for (const quarter of part.quarters) {
        assert.equal(quarter.suppliers.reduce((sum, supplier) => sum + supplier.units, 0), quarter.volume);
        close(quarter.suppliers.reduce((sum, supplier) => sum + supplier.share, 0), 1);
        if (part.firstQualifiedQuarter && quarter.quarter < part.firstQualifiedQuarter) assert.ok(quarter.suppliers.length <= 2);
      }
    }
  }
});

test("scenario ledgers reconcile and the 95% tail mean uses partial probability mass", () => {
  const { strategies } = runStudy({ includeSensitivity: false });
  for (const strategy of Object.values(strategies)) {
    close(Object.values(strategy.breakdown).reduce((sum, amount) => sum + amount, 0), strategy.expectedCost);
    close(strategy.quarterly.reduce((sum, quarter) => sum + quarter.expectedCost, 0), strategy.expectedCost);
    close(strategy.scenarioCosts.reduce((sum, scenario) => sum + scenario.probability, 0), 1);
    for (const { totalCost, goods, freight, duties, contingency, shortagePenalty, qualificationCost, holdingCost } of strategy.scenarioCosts) {
      close(goods + freight + duties + contingency + shortagePenalty + qualificationCost + holdingCost, totalCost);
    }
    const [largest, next] = strategy.scenarioCosts.toSorted((a, b) => b.totalCost - a.totalCost);
    assert.equal(largest.id, "compound");
    close(strategy.cvar95, (largest.totalCost + next.totalCost) / 2);
  }
  assert.ok(strategies.optimized.expectedCost < strategies.locked.expectedCost);
  assert.ok(strategies.optimized.cvar95 < strategies.cheapest.cvar95);
  assert.ok(strategies.optimized.expectedShortageUnits < strategies.locked.expectedShortageUnits);
});

test("zero qualification capacity disables new supply and sensitivity stays deterministic", () => {
  const config = { qualificationBudget: 0, workingCapitalBudget: 0, qualificationSlots: 0, tariffShock: 23 };
  const first = runStudy(config);
  assert.deepEqual(first, runStudy(config));
  assert.equal(first.strategies.optimized.qualificationCost, 0);
  assert.equal(first.strategies.optimized.workingCapital, 0);
  assert.ok(first.recommendation.every((part) => part.firstQualifiedQuarter === null));
  assert.ok(first.sensitivity.every((point) => point.selectedPolicies === 0));
  const current = first.sensitivity.find((point) => point.tariffShock === config.tariffShock);
  close(current.optimizedExpected, first.strategies.optimized.expectedCost);
  assert.throws(() => runStudy({ maxStartsPerQuarter: 1.5 }), RangeError);
});
