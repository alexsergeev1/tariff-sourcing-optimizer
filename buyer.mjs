// Baseline lane assumptions used when an uploaded supplier has no override.
export const lanes = Object.freeze({
  CN: Object.freeze({ freight: 0.035, duty: 0.08, policyExposure: 1, transitDays: 42 }),
  VN: Object.freeze({ freight: 0.042, duty: 0.04, policyExposure: 0.21, transitDays: 47 }),
  KR: Object.freeze({ freight: 0.048, duty: 0.025, policyExposure: 0.10, transitDays: 38 }),
  TW: Object.freeze({ freight: 0.045, duty: 0.03, policyExposure: 0.16, transitDays: 39 }),
  MX: Object.freeze({ freight: 0.028, duty: 0.02, policyExposure: 0.08, transitDays: 15 }),
  US: Object.freeze({ freight: 0.016, duty: 0, policyExposure: 0, transitDays: 8 }),
});

export const buyerLimits = Object.freeze({ components: 20, quarters: 4, unitsPerQuarter: 2_000_000, unitCost: 100_000 });

const componentFields = ["id", "name", "hs6", "quarterlyDemand", "baselineAlternateShare", "shortagePenaltyPerUnit", "primary", "alternate", "candidate"];
const supplierFields = ["country", "unitCost", "capacityShare", "dutyRate", "freightRate", "transitDays", "shockExposure"];
const candidateFields = [...supplierFields, "rampShare", "qualificationCost", "leadQuarters"];
const namePattern = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} .,'&/()+–—-]*$/u;

function record(value, path, fields) {
  if (typeof value !== "object" || value === null || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${path} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new TypeError(`${path} has an unrecognized field.`);
  }
  return value;
}

function name(value, path) {
  if (typeof value !== "string" || value.length > 80 || !namePattern.test(value.trim())) {
    throw new TypeError(`${path} must be a plain name of 1 to 80 characters.`);
  }
  return value.trim();
}

function number(value, path, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${path} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}.`);
  }
  return value;
}

function supplier(value, path, role) {
  const source = record(value, path, role === "candidate" ? candidateFields : supplierFields);
  const country = typeof source.country === "string" ? source.country.trim().toUpperCase() : "";
  if (!Object.hasOwn(lanes, country)) throw new RangeError(`${path}.country must be one of CN, VN, KR, TW, MX, US.`);
  const lane = lanes[country];
  const clean = {
    country,
    unitCost: number(source.unitCost, `${path}.unitCost`, 0.01, buyerLimits.unitCost),
    capacityShare: number(source.capacityShare, `${path}.capacityShare`, 0.01, role === "primary" ? 2 : 1),
    dutyRate: number(source.dutyRate ?? lane.duty, `${path}.dutyRate`, 0, 2),
    freightRate: number(source.freightRate ?? lane.freight, `${path}.freightRate`, 0, 1),
    transitDays: number(source.transitDays ?? lane.transitDays, `${path}.transitDays`, 0, 365),
    shockExposure: number(source.shockExposure ?? lane.policyExposure, `${path}.shockExposure`, 0, 1),
  };
  if (role === "candidate") {
    clean.rampShare = number(source.rampShare, `${path}.rampShare`, 0.01, clean.capacityShare);
    clean.qualificationCost = number(source.qualificationCost, `${path}.qualificationCost`, 0, 10_000_000);
    clean.leadQuarters = number(source.leadQuarters, `${path}.leadQuarters`, 1, 3, true);
  }
  return clean;
}

function component(value, index) {
  const path = `buyer.components[${index}]`;
  const source = record(value, path, componentFields);
  if (typeof source.id !== "string" || !/^[a-z\d][a-z\d._-]{0,35}$/i.test(source.id)) {
    throw new TypeError(`${path}.id must be an identifier of 1 to 36 characters.`);
  }
  if (typeof source.hs6 !== "string" || !/^\d{6}$/.test(source.hs6)) throw new TypeError(`${path}.hs6 must be a six-digit string.`);
  if (!Array.isArray(source.quarterlyDemand) || source.quarterlyDemand.length !== buyerLimits.quarters) {
    throw new RangeError(`${path}.quarterlyDemand must contain four whole-number quantities.`);
  }
  const quarterlyDemand = Array.from(source.quarterlyDemand, (units, quarter) =>
    number(units, `${path}.quarterlyDemand[${quarter}]`, 0, buyerLimits.unitsPerQuarter, true));
  if (!quarterlyDemand.some((units) => units > 0)) throw new RangeError(`${path}.quarterlyDemand must contain at least one positive quantity.`);
  const primary = supplier(source.primary, `${path}.primary`, "primary");
  const alternate = source.alternate == null ? null : supplier(source.alternate, `${path}.alternate`, "alternate");
  const candidate = source.candidate == null ? null : supplier(source.candidate, `${path}.candidate`, "candidate");
  const baselineAlternateShare = number(source.baselineAlternateShare ?? 0, `${path}.baselineAlternateShare`, 0, alternate?.capacityShare ?? 0);
  if (1 - baselineAlternateShare > primary.capacityShare + 1e-9) {
    throw new RangeError(`${path}.primary.capacityShare cannot cover the incumbent share of the current plan.`);
  }
  return {
    id: source.id, name: name(source.name, `${path}.name`), hs6: source.hs6,
    quarterlyDemand, baselineAlternateShare,
    shortagePenaltyPerUnit: number(source.shortagePenaltyPerUnit ?? primary.unitCost * 1.6, `${path}.shortagePenaltyPerUnit`, 0, 1_000_000),
    primary, alternate, candidate,
  };
}

export function validateBuyer(value) {
  const source = record(value, "buyer", ["name", "components"]);
  if (!Array.isArray(source.components) || source.components.length < 1 || source.components.length > buyerLimits.components) {
    throw new RangeError(`buyer.components must contain 1 to ${buyerLimits.components} components.`);
  }
  const components = Array.from(source.components, component);
  if (new Set(components.map(({ id }) => id.toLowerCase())).size !== components.length) {
    throw new TypeError("buyer.components must have unique identifiers.");
  }
  return { name: name(source.name, "buyer.name"), components };
}
