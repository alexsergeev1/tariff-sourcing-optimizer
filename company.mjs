import { validateBuyer, buyerLimits, lanes } from "./buyer.mjs?v=2";

export const companyCaseDefaults = Object.freeze({ scopePercent: 0.1, importSharePercent: 50, averageUnitCost: 75, qualificationCost: 200000, primaryCountry: "CN", candidateCountry: "MX" });

export function annualCompanyFact(snapshot, id) {
  const metric = snapshot?.facts?.find((fact) => fact.id === id);
  const point = metric?.annual;
  if (!point || !Number.isFinite(point.value) || metric.unit !== "USD") return null;
  return { ...point, id, label: metric.label, concept: metric.concept, taxonomy: metric.taxonomy, unit: metric.unit };
}

export function reportedCompanyFact(snapshot, id) {
  const metric = snapshot?.facts?.find((fact) => fact.id === id);
  if (metric?.kind !== "instant") return annualCompanyFact(snapshot, id);
  const point = metric.latest;
  if (!point || !Number.isFinite(point.value) || metric.unit !== "USD") return null;
  return { ...point, id, label: metric.label, concept: metric.concept, taxonomy: metric.taxonomy, unit: metric.unit, kind: "instant" };
}

export function companyCostBasis(snapshot) {
  const cost = annualCompanyFact(snapshot, "costOfRevenue");
  const revenue = annualCompanyFact(snapshot, "revenue");
  const validCost = cost?.value > 0 ? cost : null;
  const validRevenue = revenue?.value > 0 ? revenue : null;
  const lagDays = validCost && validRevenue ? (Date.parse(validRevenue.end) - Date.parse(validCost.end)) / 86400000 : 0;
  if (validRevenue && lagDays > 120) return { ...validRevenue, selectionReason: `Revenue is used because the retained annual cost-of-revenue period (${validCost.end}) is older than the revenue period (${validRevenue.end}).` };
  if (validCost) return { ...validCost, selectionReason: "Reported annual cost of revenue anchors the estimated spending scope." };
  if (validRevenue) return { ...validRevenue, selectionReason: "No annual cost of revenue is retained, so reported annual revenue anchors the estimated spending scope." };
  return null;
}

function bounded(value, label, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${label} must be from ${min} to ${max}.`);
  return value;
}

export function buildCompanyBuyer(snapshot, assumptions, template) {
  const ticker = snapshot?.profile?.ticker;
  if (typeof ticker !== "string" || !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker)) throw new TypeError("Choose a company with a verified public snapshot first.");
  const annualPlanningBudget = assumptions.annualPlanningBudget == null ? null : bounded(assumptions.annualPlanningBudget, "Own annual planning budget", 1, 1000000000000);
  const basis = annualPlanningBudget === null ? companyCostBasis(snapshot) : {
    id: "userEnteredSpend", label: "User-entered annual planning budget", kind: "user-entered", unit: "USD", value: annualPlanningBudget,
    selectionReason: "The user-entered planning budget replaces a percentage of reported company totals.",
  };
  if (!basis) throw new RangeError("This company has no retained annual revenue or cost-of-revenue value. Enter your own annual planning budget or use a local buyer file.");
  const clean = {
    scopePercent: annualPlanningBudget === null ? bounded(assumptions.scopePercent, "Company scope percentage", 0.001, 100) : null,
    importSharePercent: bounded(assumptions.importSharePercent, "Imported share percentage", 0.1, 100),
    averageUnitCost: bounded(assumptions.averageUnitCost, "Assumed average unit cost", 1, 50000),
    qualificationCost: bounded(assumptions.qualificationCost, "Qualification cost per candidate", 0, 10000000),
    annualPlanningBudget,
    primaryCountry: assumptions.primaryCountry,
    candidateCountry: assumptions.candidateCountry,
  };
  if (!Object.hasOwn(lanes, clean.primaryCountry) || !Object.hasOwn(lanes, clean.candidateCountry)) throw new RangeError("Choose a supported supplier origin.");
  if (clean.primaryCountry === clean.candidateCountry) throw new RangeError("Choose different incumbent and prospective supplier origins.");
  const reference = validateBuyer(template);
  const goodsSpend = basis.value * (annualPlanningBudget === null ? clean.scopePercent / 100 : 1) * clean.importSharePercent / 100;
  const originalSpend = reference.components.reduce((sum, part) => sum + part.quarterlyDemand.reduce((a, b) => a + b, 0) * part.primary.unitCost, 0);
  const originalUnits = reference.components.reduce((sum, part) => sum + part.quarterlyDemand.reduce((a, b) => a + b, 0), 0);
  const priceScale = clean.averageUnitCost / (originalSpend / originalUnits);
  const demandScale = goodsSpend / (originalSpend * priceScale);
  const adaptSupplier = (supplier, role) => {
    if (!supplier) return null;
    const country = role === "primary" ? clean.primaryCountry : role === "candidate" ? clean.candidateCountry : supplier.country;
    const lane = lanes[country];
    return { ...supplier, country, unitCost: Math.round(supplier.unitCost * priceScale * 100) / 100,
      dutyRate: lane.duty, freightRate: lane.freight, transitDays: lane.transitDays, shockExposure: lane.policyExposure,
      ...(role === "candidate" ? { qualificationCost: clean.qualificationCost } : {}) };
  };
  const components = reference.components.map((part) => {
    if (part.quarterlyDemand.some((units) => units * demandScale < 1)) throw new RangeError("The planning envelope is too small for this four-quarter basket at the assumed unit cost. Raise the scope or imported share, or lower the unit cost.");
    const quarterlyDemand = part.quarterlyDemand.map((units) => Math.round(units * demandScale));
    if (quarterlyDemand.some((units) => units > buyerLimits.unitsPerQuarter)) throw new RangeError(`The planning envelope exceeds ${buyerLimits.unitsPerQuarter.toLocaleString("en-US")} units per component per quarter. Lower the company scope or imported share, or raise the assumed unit cost.`);
    return { ...part, quarterlyDemand, shortagePenaltyPerUnit: Math.round(part.shortagePenaltyPerUnit * priceScale * 100) / 100,
      primary: adaptSupplier(part.primary, "primary"), alternate: adaptSupplier(part.alternate, "alternate"), candidate: adaptSupplier(part.candidate, "candidate") };
  });
  const buyer = validateBuyer({ name: `${ticker} estimated sourcing case`, components });
  const normalizedGoodsSpend = buyer.components.reduce((sum, part) => sum + part.quarterlyDemand.reduce((a, b) => a + b, 0) * part.primary.unitCost, 0);
  return {
    buyer,
    companyCase: { schemaVersion: 1, ticker, companyName: snapshot.profile.name, cik: snapshot.profile.cik, kind: "analyst-estimated-planning-case",
      basis, assumptions: clean, reportedScopeApplied: annualPlanningBudget === null, requestedGoodsSpend: goodsSpend, normalizedGoodsSpend,
      latestFiling: snapshot.latestFiling, snapshotAsOf: snapshot.asOf, snapshotRetrievedAt: snapshot.retrievedAt,
      limitations: ["Financial totals are reported company-wide figures, not supplier quotes, product costs, or a bill of materials.", "The scope, import share, unit costs, capacity, route terms, demand seasonality, and qualification assumptions are estimates.", "The three-component basket is a representative industrial example; its product labels are not verified company purchases or tariff classifications."] },
  };
}
