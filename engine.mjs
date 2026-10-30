import { buyerLimits, lanes, validateBuyer } from "./buyer.mjs";

const RESOURCE_STEP = 25_000;
const MAX_SEARCH_STATES = 200_000;
const QUARTERS = [1, 2, 3, 4];
const SEASON = [0.92, 1, 1.03, 1.05];

function demoSupplier(country, unitCost, capacityShare) {
  const lane = lanes[country];
  return { country, unitCost, capacityShare, dutyRate: lane.duty, freightRate: lane.freight, transitDays: lane.transitDays, shockExposure: lane.policyExposure };
}

// id, part, illustrative HS family, quarterly units, incumbent price, approved
// alternate and premium, prospective origin and premium, launch cost, lead time.
const catalog = [
  ["converter", "Power converters", "850440", 156_000, 54, "TW", 0.12, "MX", 0.17, 425_000, 1],
  ["panel", "Control panels", "853710", 104_000, 86, "KR", 0.16, "MX", 0.15, 475_000, 1],
  ["processor", "Embedded controllers", "854231", 225_000, 39, "TW", 0.11, "US", 0.23, 650_000, 2],
  ["motor", "AC motors", "850152", 117_000, 77, "VN", 0.11, "MX", 0.14, 525_000, 2],
  ["fan", "Industrial fans", "841459", 150_000, 42, "VN", 0.085, "MX", 0.12, 325_000, 1],
  ["valve", "Flow-control valves", "848180", 106_000, 67, "KR", 0.15, "US", 0.20, 400_000, 1],
  ["bearing", "Ball bearings", "848210", 300_000, 21, "VN", 0.095, "MX", 0.16, 275_000, 1],
  ["harness", "Wiring harnesses", "854442", 206_000, 32, "VN", 0.09, "MX", 0.11, 350_000, 1],
  ["switch", "Electrical switches", "853650", 205_000, 25, "TW", 0.14, "US", 0.22, 375_000, 2],
  ["housing", "Aluminum housings", "761699", 148_000, 48, "KR", 0.12, "MX", 0.13, 450_000, 1],
].map(([id, name, hs6, volume, price, alternate, alternatePremium, candidate, candidatePremium, qualificationCost, leadQuarters]) => ({
  id, name, hs6, demo: true, quarterlyDemand: SEASON.map((factor) => volume * factor), baselineAlternateShare: 0.15,
  primary: demoSupplier("CN", price, 1.13),
  alternate: demoSupplier(alternate, price * (1 + alternatePremium), 0.58),
  candidate: { ...demoSupplier(candidate, price * (1 + candidatePremium), 0.66), rampShare: 0.25, qualificationCost, leadQuarters },
  shortagePenaltyPerUnit: price * 1.6,
}));

const regimes = [
  { id: "relief", name: "Policy relief", probability: 0.20, shock: 0, demand: 0.94, disruption: {}, freight: 1 },
  { id: "base", name: "Current planning case", probability: 0.375, shock: 0.65, demand: 1, disruption: {}, freight: 1 },
  { id: "escalation", name: "Tariff escalation", probability: 0.18, shock: 1.35, demand: 1.01, disruption: {}, freight: 1.08 },
  { id: "logistics", name: "Pacific logistics disruption", probability: 0.13, shock: 0.95, demand: 1.01, disruption: { CN: 0.73, VN: 0.86, TW: 0.91, KR: 0.93 }, freight: 1.50 },
  { id: "surge", name: "Demand surge", probability: 0.09, shock: 0.72, demand: 1.11, disruption: {}, freight: 1.10 },
  { id: "compound", name: "Compounding shock", probability: 0.025, shock: 1.65, demand: 1.08, disruption: { CN: 0.49, VN: 0.75, TW: 0.76, KR: 0.80, MX: 0.96 }, freight: 1.60 },
];
const adverseIds = new Set(["escalation", "logistics", "compound"]);
const adverseProbability = regimes.reduce((sum, row) => sum + (adverseIds.has(row.id) ? row.probability : 0), 0);
const staticRegime = { id: "static", probability: 1, shock: 0, demand: 1, disruption: {}, freight: 1 };

const defaults = {
  portfolioScale: 1, tariffShock: 20, qualificationBudget: 1_800_000,
  qualificationSlots: 4, maxStartsPerQuarter: 2, workingCapitalBudget: 4_200_000, riskWeight: 0.55,
};

function finiteInRange(value, name, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a number from ${min} to ${max}.`);
  }
  return value;
}

function validateConfig(options) {
  const config = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, options[name] ?? value]));
  finiteInRange(config.portfolioScale, "portfolioScale", 0.25, 4);
  finiteInRange(config.tariffShock, "tariffShock", 0, 80);
  finiteInRange(config.qualificationBudget, "qualificationBudget", 0, 10_000_000);
  finiteInRange(config.workingCapitalBudget, "workingCapitalBudget", 0, 20_000_000);
  finiteInRange(config.riskWeight, "riskWeight", 0, 2);
  for (const name of ["qualificationSlots", "maxStartsPerQuarter"]) {
    if (!Number.isInteger(config[name])) throw new RangeError(`${name} must be an integer.`);
    finiteInRange(config[name], name, 0, buyerLimits.components);
  }
  return config;
}

function enumeratePolicies(part) {
  const { baselineAlternateShare, primary, alternate, candidate } = part;
  const policies = [{ id: "locked", name: "Keep current split", alternateShare: baselineAlternateShare, newShare: 0, launch: 0 }];
  if (alternate) {
    const options = [
      ["concentrate", "Concentrate incumbent", 0],
      ["approved", part.demo ? `Expand approved ${alternate.country} supplier` : `Use approved ${alternate.country} supplier at 35%`, 0.35],
      ["dual-approved", part.demo ? `Split with approved ${alternate.country} supplier` : `Use approved ${alternate.country} supplier at 50%`, 0.50],
      ["alternate-cap", `Use approved ${alternate.country} supplier at capacity`, alternate.capacityShare],
    ];
    // The original demo has only its fixed 35% and 50% candidate splits.
    if (part.demo) options.pop();
    const shares = new Set([baselineAlternateShare]);
    for (const [id, name, alternateShare] of options) {
      if (shares.has(alternateShare) || alternateShare > alternate.capacityShare || 1 - alternateShare > primary.capacityShare + 1e-9) continue;
      shares.add(alternateShare);
      policies.push({ id, name, alternateShare, newShare: 0, launch: 0 });
    }
  }
  if (!candidate || baselineAlternateShare === 1) return policies;
  for (const launch of [1, 2]) {
    if (launch + candidate.leadQuarters > 4) continue;
    const maxShare = Math.min(candidate.capacityShare, 1 - baselineAlternateShare);
    const shares = new Set([0.25, 0.45, 0.60].map((share) => Math.min(share, maxShare)));
    if (!part.demo) shares.add(maxShare);
    for (const newShare of shares) {
      policies.push({
        id: `q${launch}-${newShare}`,
        name: `Qualify ${candidate.country} in Q${launch}`,
        alternateShare: baselineAlternateShare, newShare, launch,
      });
    }
  }
  return policies;
}

function planQuarter(part, policy, quarter, scale) {
  const volume = Math.round(part.quarterlyDemand[quarter - 1] * scale);
  const quartersReady = policy.launch ? Math.max(0, quarter - policy.launch - part.candidate.leadQuarters + 1) : 0;
  const rampShare = part.candidate ? Math.min(part.candidate.capacityShare, quartersReady * part.candidate.rampShare) : 0;
  const candidateShare = Math.min(policy.newShare, rampShare);
  const alternateShare = policy.alternateShare;
  const suppliers = [
    { ...part.primary, role: "primary", share: Math.max(0, 1 - alternateShare - candidateShare) },
    { ...(part.alternate ?? part.primary), role: "alternate", share: alternateShare, capacityShare: part.alternate?.capacityShare ?? 0 },
    { ...(part.candidate ?? part.primary), role: "candidate", share: candidateShare, capacityShare: rampShare },
  ];
  const alternateUnits = Math.round(volume * alternateShare);
  const candidateUnits = Math.min(volume - alternateUnits, Math.round(volume * candidateShare));
  suppliers[0].units = volume - alternateUnits - candidateUnits;
  suppliers[1].units = alternateUnits;
  suppliers[2].units = candidateUnits;
  return { quarter, volume, suppliers };
}

function pipelineCapital(quarter) {
  return quarter.suppliers.reduce((cash, supplier) =>
    cash + supplier.units * supplier.unitCost * supplier.transitDays / 91.25, 0);
}

function scoreQuarter(part, policy, plan, regime, tariffShock) {
  const demand = Math.round(plan.volume * regime.demand);
  let remaining = demand;
  let goods = 0, freight = 0, duties = 0, contingency = 0;
  const supplierState = plan.suppliers.map((supplier) => {
    const capacity = Math.floor(plan.volume * supplier.capacityShare * (regime.disruption[supplier.country] ?? 1));
    const tariff = supplier.dutyRate + tariffShock / 100 * regime.shock * supplier.shockExposure;
    return { supplier, capacity, tariff, delivered: 0 };
  });

  function purchase(state, units, emergency) {
    const { supplier, tariff } = state;
    const value = units * supplier.unitCost;
    goods += value;
    freight += value * supplier.freightRate * regime.freight;
    duties += value * tariff;
    if (emergency) contingency += value * 0.09;
    state.delivered += units;
    remaining -= units;
  }

  const targetAlternate = Math.round(demand * plan.suppliers[1].share);
  const targetCandidate = Math.min(demand - targetAlternate, Math.round(demand * plan.suppliers[2].share));
  const orders = [demand - targetAlternate - targetCandidate, targetAlternate, targetCandidate];
  for (const [i, state] of supplierState.entries()) purchase(state, Math.min(orders[i], state.capacity), false);

  // Contingency orders can only fill a shortfall through pre-approved capacity.
  const overflow = supplierState.toSorted((a, b) =>
    a.supplier.unitCost * (1 + a.tariff + a.supplier.freightRate * regime.freight) -
    b.supplier.unitCost * (1 + b.tariff + b.supplier.freightRate * regime.freight));
  for (const state of overflow) {
    if (remaining <= 0) break;
    purchase(state, Math.min(remaining, state.capacity - state.delivered), true);
  }

  const shortageUnits = remaining;
  const shortagePenalty = shortageUnits * part.shortagePenaltyPerUnit;
  const qualificationCost = policy.launch === plan.quarter ? part.candidate.qualificationCost : 0;
  const holdingCost = pipelineCapital(plan) * 0.11 / 4;
  const totalCost = goods + freight + duties + contingency + shortagePenalty + qualificationCost + holdingCost;
  return { totalCost, shortageUnits, demand, goods, freight, duties, contingency, shortagePenalty, qualificationCost, holdingCost };
}

function weighted(records, key, scenarios = regimes) {
  return records.reduce((sum, row, i) => sum + row[key] * scenarios[i].probability, 0);
}

function evaluatePolicy(part, policy, config, lockedQuarters) {
  const quarters = QUARTERS.map((quarter) => planQuarter(part, policy, quarter, config.portfolioScale));
  const workingCapital = Math.max(0, ...quarters.map((quarter, i) => pipelineCapital(quarter) - pipelineCapital(lockedQuarters[i])));
  const scenarioCosts = regimes.map((regime) => {
    const results = quarters.map((quarter) => scoreQuarter(part, policy, quarter, regime, config.tariffShock));
    const total = Object.fromEntries(Object.keys(results[0]).map((key) => [key, results.reduce((sum, row) => sum + row[key], 0)]));
    return { id: regime.id, ...total, quarters: results };
  });
  const expectedCost = weighted(scenarioCosts, "totalCost");
  const adverseCost = scenarioCosts.reduce((sum, row, i) =>
    sum + (adverseIds.has(row.id) ? row.totalCost * regimes[i].probability : 0), 0) / adverseProbability;
  const staticCost = quarters.reduce((sum, quarter) => sum + scoreQuarter(part, policy, quarter, staticRegime, 0).totalCost, 0);
  const qualificationCost = policy.launch ? part.candidate.qualificationCost : 0;
  return {
    part, policy, quarters, scenarioCosts, expectedCost, adverseCost, staticCost, qualificationCost, workingCapital,
    score: (expectedCost + config.riskWeight * adverseCost) / (1 + config.riskWeight),
    slots: Number(Boolean(policy.launch)), qualificationUnits: Math.ceil(qualificationCost / RESOURCE_STEP),
    capitalUnits: Math.ceil(workingCapital / RESOURCE_STEP),
  };
}

function solve(optionsByComponent, config, objective) {
  const qualificationLimit = Math.floor(config.qualificationBudget / RESOURCE_STEP);
  const capitalLimit = Math.floor(config.workingCapitalBudget / RESOURCE_STEP);
  const capitalStride = capitalLimit + 1;
  const slotStride = (qualificationLimit + 1) * capitalStride;
  const firstQuarterStride = (config.qualificationSlots + 1) * slotStride;
  let states = new Map([[0, { slots: 0, firstQuarter: 0, qualification: 0, capital: 0, score: 0, choices: [] }]]);
  let visited = 0;

  for (const options of optionsByComponent) {
    const next = new Map();
    for (const state of states.values()) {
      for (const option of options) {
        const slots = state.slots + option.slots;
        const firstQuarter = state.firstQuarter + Number(option.policy.launch === 1);
        const qualification = state.qualification + option.qualificationUnits;
        const capital = state.capital + option.capitalUnits;
        if (slots > config.qualificationSlots || qualification > qualificationLimit || capital > capitalLimit) continue;
        if (firstQuarter > config.maxStartsPerQuarter || slots - firstQuarter > config.maxStartsPerQuarter) continue;
        visited++;
        const key = firstQuarter * firstQuarterStride + slots * slotStride + qualification * capitalStride + capital;
        const score = state.score + option[objective];
        const previous = next.get(key);
        if (!previous || score < previous.score - 1e-7) next.set(key, { slots, firstQuarter, qualification, capital, score, choices: [...state.choices, option] });
        if (next.size > MAX_SEARCH_STATES) throw new RangeError("The portfolio exceeds the search-state limit. Lower the cash or qualification limits, or upload fewer components.");
      }
    }
    states = next;
  }
  let best;
  for (const state of states.values()) {
    if (!best || state.score < best.score - 1e-7) best = state;
  }
  return { choices: best.choices, score: best.score, visited, reachable: states.size };
}

function cvar95(scenarioCosts) {
  let probabilityLeft = 0.05;
  let total = 0;
  for (const row of scenarioCosts.toSorted((a, b) => b.totalCost - a.totalCost)) {
    const weight = Math.min(row.probability, probabilityLeft);
    total += weight * row.totalCost;
    probabilityLeft -= weight;
    if (probabilityLeft <= 1e-12) break;
  }
  return total / 0.05;
}

function describe(option, lockedCost) {
  const { part, policy, qualificationCost, workingCapital, expectedCost } = option;
  const finalShare = option.quarters.at(-1).suppliers[2].share;
  const label = policy.launch ? `${policy.name} to reach ${Math.round(finalShare * 100)}% by Q4` : policy.name;
  return {
    id: part.id, name: part.name, hts: part.hs6, policy: label, policyId: policy.id,
    qualificationCost, workingCapital, qualificationQuarter: policy.launch || null,
    candidateCountry: policy.launch ? part.candidate.country : null,
    firstQualifiedQuarter: policy.launch ? policy.launch + part.candidate.leadQuarters : null,
    expectedCost, expectedSavings: lockedCost - expectedCost,
    quarters: option.quarters.map(({ quarter, volume, suppliers }) => ({
      quarter, volume, suppliers: suppliers.filter((supplier) => supplier.units > 0)
        .map(({ country, role, units, share }) => ({ country, role, units, share })),
    })),
  };
}

function summarize(label, options, lockedOptions) {
  const fields = ["totalCost", "shortageUnits", "demand", "goods", "freight", "duties", "contingency", "shortagePenalty", "qualificationCost", "holdingCost"];
  const scenarioCosts = regimes.map(({ id, name, probability }, i) => ({
    id, name, probability,
    ...Object.fromEntries(fields.map((field) => [field, options.reduce((sum, option) => sum + option.scenarioCosts[i][field], 0)])),
  }));
  const expectedCost = weighted(scenarioCosts, "totalCost");
  const expectedShortageUnits = weighted(scenarioCosts, "shortageUnits");
  const expectedUnits = weighted(scenarioCosts, "demand");
  return {
    label, expectedCost, cvar95: cvar95(scenarioCosts), worstCost: Math.max(...scenarioCosts.map((row) => row.totalCost)),
    expectedShortageUnits, expectedUnits, fillRate: expectedUnits ? 1 - expectedShortageUnits / expectedUnits : 1,
    qualificationCost: options.reduce((sum, option) => sum + option.qualificationCost, 0),
    qualificationSlots: options.reduce((sum, option) => sum + option.slots, 0),
    qualificationStarts: QUARTERS.map((quarter) => options.filter((option) => option.policy.launch === quarter).length),
    workingCapital: options.reduce((sum, option) => sum + option.workingCapital, 0),
    budgetedWorkingCapital: options.reduce((sum, option) => sum + option.capitalUnits * RESOURCE_STEP, 0),
    breakdown: Object.fromEntries(fields.slice(3).map((field) => [field, weighted(scenarioCosts, field)])),
    scenarioCosts,
    quarterly: QUARTERS.map((quarter, q) => ({
      quarter,
      expectedCost: options.reduce((sum, option) => sum + weighted(option.scenarioCosts.map((row) => row.quarters[q]), "totalCost"), 0),
      expectedShortageUnits: options.reduce((sum, option) => sum + weighted(option.scenarioCosts.map((row) => row.quarters[q]), "shortageUnits"), 0),
    })),
    allocations: options.map((option, i) => describe(option, lockedOptions[i].expectedCost)),
  };
}

function prepare(config, components) {
  return components.map((part) => {
    const policies = enumeratePolicies(part);
    const locked = QUARTERS.map((quarter) => planQuarter(part, policies[0], quarter, config.portfolioScale));
    return policies.map((policy) => evaluatePolicy(part, policy, config, locked));
  });
}

export function runStudy(options = {}) {
  const config = validateConfig(options);
  const buyerInput = options.buyer == null ? null : validateBuyer(options.buyer);
  const components = buyerInput?.components ?? catalog;
  const choices = prepare(config, components);
  const locked = choices.map((part) => part[0]);
  const robust = solve(choices, config, "score");
  const cheapest = solve(choices, config, "staticCost");
  const strategy = {
    optimized: summarize("Scenario-weighted plan", robust.choices, locked),
    cheapest: summarize("Cheapest static plan", cheapest.choices, locked),
    locked: summarize("Keep current sourcing", locked, locked),
  };
  const tariffPoints = [...new Set([0, 5, 10, 15, 20, 30, 45, 60, 80, config.tariffShock])].sort((a, b) => a - b);
  const sensitivity = options.includeSensitivity === false ? [] : tariffPoints.map((tariffShock) => {
    const adjusted = { ...config, tariffShock };
    const study = tariffShock === config.tariffShock ? choices : prepare(adjusted, components);
    const solution = tariffShock === config.tariffShock ? robust : solve(study, adjusted, "score");
    return {
      tariffShock, optimizedExpected: solution.choices.reduce((sum, row) => sum + row.expectedCost, 0),
      lockedExpected: study.reduce((sum, row) => sum + row[0].expectedCost, 0),
      selectedPolicies: solution.choices.filter((row) => row.policy.launch).length,
      portfolio: solution.choices.map((row) => ({ id: row.part.id, policyId: row.policy.id })),
    };
  });
  const nextDecisionChange = sensitivity.find((point) => point.tariffShock > config.tariffShock &&
    point.portfolio.some((row, i) => row.policyId !== robust.choices[i].policy.id));
  return {
    config,
    buyer: { name: buyerInput?.name ?? "Representative industrial buyer", kind: buyerInput ? "custom" : "demo", componentCount: components.length },
    buyerInput,
    components: components.map(({ id, name, hs6 }) => ({ id, name, hts: hs6 })),
    scenarios: regimes.map(({ id, name, probability, demand, shock }) => ({ id, name, probability, demand, shock })),
    strategies: strategy, recommendation: strategy.optimized.allocations, sensitivity,
    nextDecisionChange: nextDecisionChange?.tariffShock ?? null,
    validation: {
      objective: "Blend expected modeled cost with the conditional cost of the three adverse regimes",
      method: "Exact multiple-choice dynamic programming over enumerated quarterly policies and conservative budget units",
      budgetStep: RESOURCE_STEP, candidatePolicies: choices.reduce((sum, row) => sum + row.length, 0),
      feasibleTransitions: robust.visited, reachableBudgetStates: robust.reachable,
      forecastSource: buyerInput ? "Buyer-supplied planning assumptions with modeled stress scenarios" : "Modeled buyer, contracts, duties and scenario weights",
      maxSearchStates: MAX_SEARCH_STATES,
      tailMetric: "Mean of the most expensive 5% of the discrete scenario distribution",
    },
  };
}
