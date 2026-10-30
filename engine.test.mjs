import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { validateBuyer } from "./buyer.mjs";
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

const example = JSON.parse(readFileSync(new URL("./data/buyer.example.json", import.meta.url), "utf8"));

test("a custom buyer uses submitted quarterly demand, routes and bounded qualification", () => {
  const config = { buyer: example, tariffShock: 25, qualificationBudget: 225_000, qualificationSlots: 1, maxStartsPerQuarter: 1, includeSensitivity: false };
  const study = runStudy(config);
  assert.equal(study.buyer.kind, "custom");
  assert.equal(study.buyer.componentCount, 3);
  assert.equal(study.buyerInput.components[0].primary.dutyRate, 0.12);
  assert.equal(study.buyerInput.components[0].alternate.transitDays, 39);
  assert.equal(study.buyerInput.components[1].alternate, null);
  assert.deepEqual(study.recommendation.map((part) => part.quarters.map(({ volume }) => volume)), example.components.map((part) => part.quarterlyDemand));
  assert.ok(study.strategies.optimized.qualificationCost <= config.qualificationBudget);
  const launches = study.recommendation.filter((part) => part.qualificationQuarter);
  assert.equal(launches.length, 1);
  for (const quarter of launches[0].quarters) {
    const candidate = quarter.suppliers.find(({ role }) => role === "candidate");
    if (quarter.quarter < launches[0].firstQualifiedQuarter) assert.equal(candidate, undefined);
    else assert.equal(candidate?.country, launches[0].candidateCountry);
  }
  assert.deepEqual(runStudy({ ...config, buyer: study.buyerInput }), study);
});

test("custom buyer validation rejects duplicate IDs, non-numeric values, invalid capacities and markup", () => {
  const invalid = (modify, error) => {
    const buyer = structuredClone(example);
    modify(buyer, buyer.components[0]);
    assert.throws(() => validateBuyer(buyer), error);
  };
  invalid((buyer, part) => { buyer.components[1].id = part.id.toUpperCase(); }, /unique identifiers/);
  invalid((_, part) => { part.quarterlyDemand[0] = "95000"; }, /quarterlyDemand\[0\]/);
  invalid((_, part) => { part.primary.country = "ZZ"; }, /primary.country/);
  invalid((_, part) => { part.baselineAlternateShare = 0.8; }, /baselineAlternateShare/);
  invalid((_, part) => { part.candidate.rampShare = 0.8; }, /candidate.rampShare/);
  invalid((_, part) => { part.name = "<script>alert(1)</script>"; }, /plain name/);
  invalid((_, part) => { part.primary.override = 1; }, /unrecognized field/);
});
