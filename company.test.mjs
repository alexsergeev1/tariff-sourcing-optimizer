import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { annualCompanyFact, reportedCompanyFact, buildCompanyBuyer, companyCaseDefaults, companyCostBasis } from "./company.mjs";
import { runStudy } from "./engine.mjs";

const template = JSON.parse(await readFile(new URL("./data/buyer.example.json", import.meta.url), "utf8"));
const snapshot = { profile: { ticker: "TEST", name: "Test manufacturer" }, facts: [
  { id: "costOfRevenue", label: "Cost of revenue", unit: "USD", concept: "CostOfRevenue", annual: { value: 14000000000, start: "2025-01-01", end: "2025-12-31", url: "https://www.sec.gov/Archives/example" } },
  { id: "revenue", label: "Revenue", unit: "USD", annual: { value: 20000000000, end: "2025-12-31" } },
] };

test("company totals anchor an explicitly estimated sourcing envelope, with replayable inputs", () => {
  const { buyer, companyCase } = buildCompanyBuyer(snapshot, companyCaseDefaults, template);
  assert.equal(companyCase.basis.id, "costOfRevenue");
  assert.equal(companyCase.requestedGoodsSpend, 7000000);
  assert.ok(Math.abs(companyCase.normalizedGoodsSpend - 7000000) < 1000);
  assert.equal(buyer.components.length, 3);
  assert.equal(buyer.components[0].primary.country, "CN");
  assert.equal(buyer.components[0].candidate.country, "MX");
  const study = runStudy({ buyer });
  assert.equal(study.buyer.name, "TEST estimated sourcing case");
  assert.ok(study.strategies.optimized.qualificationCost <= study.config.qualificationBudget);
});

test("missing annual facts never get replaced with quarterly annualization", () => {
  assert.equal(companyCostBasis({ facts: [{ id: "revenue", unit: "USD", quarterly: { value: 200 } }] }), null);
  assert.equal(annualCompanyFact({ facts: [{ id: "revenue", unit: "EUR", annual: { value: 200 } }] }, "revenue"), null);
  const revenueOnly = structuredClone(snapshot);
  revenueOnly.facts.shift();
  assert.equal(companyCostBasis(revenueOnly).id, "revenue");
  const staleCost = structuredClone(snapshot);
  staleCost.facts[0].annual.end = "2021-12-31";
  assert.equal(companyCostBasis(staleCost).id, "revenue");
  assert.match(companyCostBasis(staleCost).selectionReason, /older than/);
  assert.equal(reportedCompanyFact({ facts: [{ id: "inventory", kind: "instant", unit: "USD", latest: { value: 230, end: "2026-09-30" } }] }, "inventory").value, 230);
});

test("invalid and unrepresentable company planning cases fail before optimization", () => {
  assert.throws(() => buildCompanyBuyer(snapshot, { ...companyCaseDefaults, scopePercent: NaN }, template), /scope percentage/);
  assert.throws(() => buildCompanyBuyer(snapshot, { ...companyCaseDefaults, primaryCountry: "<script>" }, template), /origin/);
  assert.throws(() => buildCompanyBuyer(snapshot, { ...companyCaseDefaults, candidateCountry: "CN" }, template), /different/);
  assert.throws(() => buildCompanyBuyer(snapshot, { ...companyCaseDefaults, scopePercent: 100, averageUnitCost: 1 }, template), /planning envelope/);
  assert.throws(() => buildCompanyBuyer(snapshot, { ...companyCaseDefaults, scopePercent: 0.001, importSharePercent: 0.1, averageUnitCost: 50000 }, template), /too small/);
  assert.throws(() => buildCompanyBuyer({ profile: { ticker: "X" }, facts: [] }, companyCaseDefaults, template), /annual revenue/);
});

test("a directory-only company can use an explicit own budget without inferred financials", () => {
  const directoryOnly = { profile: { ticker: "OTHER", name: "Directory company", cik: "0000123456" }, facts: [] };
  const { buyer, companyCase } = buildCompanyBuyer(directoryOnly, { ...companyCaseDefaults, scopePercent: NaN, annualPlanningBudget: 30000000, importSharePercent: 40 }, template);
  assert.equal(companyCase.basis.kind, "user-entered");
  assert.equal(companyCase.basis.id, "userEnteredSpend");
  assert.equal(companyCase.basis.value, 30000000);
  assert.equal(companyCase.basis.end, undefined);
  assert.equal(companyCase.requestedGoodsSpend, 12000000);
  assert.equal(companyCase.reportedScopeApplied, false);
  assert.equal(companyCase.assumptions.scopePercent, null);
  assert.equal(companyCase.cik, "0000123456");
  assert.equal(buyer.components.length, 3);
  assert.ok(runStudy({ buyer }).strategies.optimized.expectedCost > 12000000);
  assert.throws(() => buildCompanyBuyer(directoryOnly, { ...companyCaseDefaults, annualPlanningBudget: -1 }, template), /annual planning budget/);
  const manualReported = buildCompanyBuyer(snapshot, { ...companyCaseDefaults, annualPlanningBudget: 10000000 }, template);
  assert.equal(manualReported.companyCase.requestedGoodsSpend, 5000000);
  assert.equal(manualReported.companyCase.basis.kind, "user-entered");
});
