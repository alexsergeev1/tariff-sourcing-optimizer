import { validateBuyer } from "./buyer.mjs?v=2";
import { boardMemo } from "./memo.mjs?v=1";
import { reportedCompanyFact, buildCompanyBuyer, companyCostBasis } from "./company.mjs?v=1";
import { loadCompanyIndex, loadCompanySnapshot } from "./company-source.mjs?v=1";

const $ = (id) => document.getElementById(id);
const assetVersion = new URL(import.meta.url).search;
const quantity = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const origins = { CN: "China", VN: "Vietnam", KR: "South Korea", TW: "Taiwan", MX: "Mexico", US: "United States" };
const inputs = [
  ["tariff-shock", "tariff-value", "tariffShock", (value) => `+${value} pp`],
  ["qual-budget", "qual-value", "qualificationBudget", money],
  ["capital-budget", "capital-value", "workingCapitalBudget", money],
  ["qualification-slots", "slots-value", "qualificationSlots", quantity.format],
  ["risk-weight", "risk-value", "riskWeight", (value) => value.toFixed(2)],
];

let study;
let schedule;
let imports;
let buyer;
let buyerRead = 0;
let pendingRun = false;
let loadingSample = false;
let appliedBuyerVersion = 0;
let companyIndex;
let companySnapshot;
let companySelection = 0;
let companyAbort;
let pendingCompanyCase;
let runCompanyCase;
let appliedCompanyCase;
let companyDraftChanged = false;
let marketIndex;
let marketSearch = 0;
const chapters = new Map();
const worker = new Worker(new URL("./worker.mjs?v=2", import.meta.url), { type: "module" });

function money(value) {
  const amount = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (amount >= 1e9) return `${sign}$${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `${sign}$${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 1e3) return `${sign}$${(amount / 1e3).toFixed(0)}K`;
  return dollars.format(value);
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function publicLink(label, address) {
  try {
    const url = new URL(address);
    if (url.protocol !== "https:") throw new Error("Unsupported source URL");
    const link = element("a", label);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  } catch {
    return element("span", label + " (link unavailable)");
  }
}

function companyAssumptions() {
  const ownBudget = $("company-budget").value.trim();
  return {
    scopePercent: Number($("company-scope").value), importSharePercent: Number($("company-import-share").value),
    averageUnitCost: Number($("company-unit-cost").value), qualificationCost: Number($("company-qualification").value),
    primaryCountry: $("company-primary").value, candidateCountry: $("company-candidate").value,
    annualPlanningBudget: ownBudget === "" ? null : Number(ownBudget) * 1000000,
  };
}

function updateCompanyControls() {
  const busy = !companySnapshot?.profile?.ticker || pendingRun || loadingSample;
  const ownBudget = companyAssumptions().annualPlanningBudget;
  $("company-case-inputs").disabled = busy;
  $("apply-company-case").disabled = busy || (!companyCostBasis(companySnapshot) && !(Number.isFinite(ownBudget) && ownBudget > 0));
  $("company-scope").disabled = ownBudget !== null || !companyCostBasis(companySnapshot);
}

function renderCompanyCaseStatus(message) {
  const status = $("company-case-status");
  status.replaceChildren(element("span", message ?? (appliedCompanyCase
    ? `Current results: ${appliedCompanyCase.ticker} estimated sourcing case. ${companyDraftChanged ? "Company or assumptions changed; build a case to update results." : appliedCompanyCase.basis.kind === "user-entered" ? "Your entered budget anchors the estimated basket." : "Reported company totals anchor the estimated basket."}`
    : "The current results use the demo or uploaded buyer. Build a company case to apply these estimates.")));
  if (appliedCompanyCase) {
    const link = element("a", "See the recommended orders →", "case-result-link");
    link.href = "#allocation";
    status.append(element("br"), link);
  }
}

function previewCompanyEnvelope() {
  const basis = companyCostBasis(companySnapshot);
  const assumptions = companyAssumptions();
  const spend = (assumptions.annualPlanningBudget ?? basis?.value * assumptions.scopePercent / 100) * assumptions.importSharePercent / 100;
  $("company-envelope").textContent = `Estimated annual goods envelope: ${Number.isFinite(spend) && spend > 0 ? money(spend) : "—"}`;
  $("company-basis").textContent = assumptions.annualPlanningBudget !== null
    ? `User-entered spend basis: ${Number.isFinite(assumptions.annualPlanningBudget) ? money(assumptions.annualPlanningBudget) : "—"} annual planning budget. The company-total scope percentage is not applied. Imported share defines the goods envelope; no public company financial value is inferred.`
    : basis ? `${basis.id === "costOfRevenue" ? "Reported-cost" : "Revenue"}-anchored planning envelope: ${money(basis.value)} reported annual ${(basis.label ?? basis.id).toLowerCase()}, period ending ${basis.end}. ${basis.selectionReason} This is a company-wide total; the percentages below are your estimates.`
      : "No retained annual revenue or cost-of-revenue anchor is available. Enter your own annual planning budget to build a case for this company.";
}

function renderCompanyMatches() {
  if (!companyIndex) return;
  const query = $("company-query").value.trim().toLowerCase();
  const matches = companyIndex.companies.filter((entry) => !query || entry.ticker.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query));
  matches.sort((left, right) => Number(right.ticker.toLowerCase() === query) - Number(left.ticker.toLowerCase() === query) || Number(right.hasSnapshot) - Number(left.hasSnapshot) || left.ticker.localeCompare(right.ticker));
  const shown = matches.slice(0, 8);
  $("company-matches").replaceChildren(...shown.map((entry) => {
    const button = element("button");
    button.type = "button";
    button.dataset.ticker = entry.ticker;
    button.append(element("span", `${entry.ticker} · ${entry.name}`), element("small", entry.hasFinancials === false && entry.hasSnapshot ? "Profile + filings" : entry.hasSnapshot ? "Financial snapshot" : "SEC directory"));
    button.addEventListener("click", () => selectCompany(entry));
    return button;
  }));
  $("company-search-status").textContent = `${quantity.format(matches.length)} matching companies${matches.length > 8 ? "; showing eight. Refine the ticker or name." : "."} ${companyIndex.delivery === "online" ? "Online" : "Bundled"} SEC directory.`;
}

async function selectCompany(entry) {
  const version = ++companySelection;
  companyAbort?.abort();
  companyAbort = new AbortController();
  companySnapshot = { schemaVersion: 1, asOf: companyIndex?.asOf, retrievedAt: companyIndex?.retrievedAt,
    profile: { ticker: entry.ticker, name: entry.name, cik: entry.cik, tickers: [entry.ticker] },
    facts: [], coverage: "directory-only" };
  companyDraftChanged = true;
  $("company-query").value = entry.ticker;
  $("company-matches").replaceChildren();
  $("company-search-status").textContent = `Selected ${entry.ticker} · ${entry.hasSnapshot ? "financial snapshot available" : "SEC directory only"}. Search again to change company.`;
  $("company-name").textContent = `${entry.ticker} · ${entry.name}`;
  $("company-profile").textContent = entry.hasSnapshot ? "Loading reported financial evidence…" : "This SEC directory company has no financial snapshot in the current coverage. No financial values have been inferred.";
  $("company-facts").replaceChildren();
  $("company-filings").replaceChildren(publicLink("Open company filings on SEC EDGAR ↗", `https://www.sec.gov/edgar/browse/?CIK=${encodeURIComponent(entry.cik)}&owner=exclude`));
  $("company-basis").textContent = "Select a company with a retained annual revenue or cost-of-revenue value.";
  updateCompanyControls();
  previewCompanyEnvelope();
  renderCompanyCaseStatus();
  if (!entry.hasSnapshot) return;
  try {
    const snapshot = await loadCompanySnapshot(entry, { signal: companyAbort.signal });
    if (version !== companySelection) return;
    companySnapshot = snapshot;
    const profile = snapshot.profile;
    $("company-name").textContent = `${entry.ticker} · ${profile.name}`;
    const retainedFacts = snapshot.facts.length;
    $("company-search-status").textContent = `Selected ${entry.ticker} · ${retainedFacts ? `${retainedFacts} retained financial metrics` : "profile and filings only; financial facts are not yet retained"}. Search again to change company.`;
    $("company-profile").textContent = `${profile.sicDescription ?? "SEC issuer"} · ${snapshot.delivery === "online" ? "Online" : "Bundled"} snapshot retrieved ${(snapshot.retrievedAt ?? snapshot.asOf ?? "date unavailable").slice(0, 10)}. ${retainedFacts ? "Each value retains its reporting period." : "No financial values are available in this snapshot. The filing links remain available."}`;
    if (snapshot.status === "stale" || snapshot.status === "partial") {
      $("company-profile").textContent += " The latest refresh was incomplete. Retained figures keep their original source dates.";
    }
    const facts = ["revenue", "costOfRevenue", "inventory", "operatingIncome"].map((id) => reportedCompanyFact(snapshot, id)).filter(Boolean);
    $("company-facts").replaceChildren(...facts.map((fact) => {
      const card = element("article");
      card.append(element("span", fact.label ?? fact.id), element("strong", money(fact.value)), element("small", fact.start ? `Annual period ${fact.start} to ${fact.end}` : `Balance at ${fact.end}`), publicLink(`Reported ${fact.filed ?? "date unavailable"} ↗`, fact.url));
      return card;
    }));
    const filing = snapshot.latestFiling;
    const filings = [];
    if (filing?.url) {
      const line = element("p");
      line.append(publicLink(`Most recent filing: ${filing.form} · ${filing.filed} ↗`, filing.url), element("br"), element("span", `Reporting period ${filing.periodEnd ?? "unavailable"}`));
      filings.push(line);
    }
    const sources = element("p");
    sources.append(publicLink("SEC company facts ↗", snapshot.sources?.companyFacts), element("span", " · "), publicLink("SEC submissions ↗", snapshot.sources?.submissions));
    filings.push(sources);
    $("company-filings").replaceChildren(...filings);
    updateCompanyControls();
    previewCompanyEnvelope();
  } catch (error) {
    if (version === companySelection) $("company-profile").textContent = `Could not load financial evidence. ${error.message}`;
  }
}

async function initializeCompanies() {
  try {
    companyIndex = await loadCompanyIndex();
    const financialCount = companyIndex.companies.filter(({ hasFinancials }) => hasFinancials).length;
    $("company-coverage").textContent = `${quantity.format(companyIndex.companies.length)} searchable tickers · ${companyIndex.snapshotCount ?? 0} company profiles · ${financialCount} with retained financials. Every company can use your own planning budget.`;
    renderCompanyMatches();
    const example = companyIndex.companies.find((entry) => entry.ticker === "CAT" && entry.hasSnapshot) ?? companyIndex.companies.find((entry) => entry.hasSnapshot);
    if (example && !$("company-query").value.trim()) await selectCompany(example);
  } catch (error) {
    $("company-search-status").textContent = `Company directory unavailable. ${error.message} The buyer model and trade evidence remain usable.`;
  }
}

$("company-query").addEventListener("input", renderCompanyMatches);
$("company-search").addEventListener("submit", (event) => {
  event.preventDefault();
  renderCompanyMatches();
  const query = $("company-query").value.trim().toUpperCase();
  const exact = companyIndex?.companies.find((entry) => entry.ticker === query);
  if (exact) selectCompany(exact);
});
$("company-case-form").addEventListener("input", () => {
  companyDraftChanged = true;
  updateCompanyControls();
  previewCompanyEnvelope();
  renderCompanyCaseStatus();
});
$("company-case-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pendingRun || loadingSample || !companySnapshot) return;
  const selected = companySelection;
  const snapshot = companySnapshot;
  const assumptions = companyAssumptions();
  loadingSample = true;
  $("run-study").disabled = true;
  $("run-sample").disabled = true;
  updateCompanyControls();
  renderCompanyCaseStatus("Building the estimated planning case…");
  let ready = false;
  try {
    const response = await fetch("./data/buyer.example.json" + assetVersion);
    if (!response.ok) throw new Error("The representative buyer template is unavailable.");
    const result = buildCompanyBuyer(snapshot, assumptions, await response.json());
    if (selected !== companySelection) return;
    buyerRead++;
    buyer = result.buyer;
    pendingCompanyCase = result.companyCase;
    companyDraftChanged = false;
    $("buyer-status").textContent = `${buyer.name} · running estimated case.`;
    $("reset-buyer").disabled = false;
    ready = true;
  } catch (error) {
    if (selected === companySelection) renderCompanyCaseStatus(`Case rejected. ${error.message}`);
  } finally {
    loadingSample = false;
    if (ready) executeStudy();
    else finishStudy();
  }
});

function difference(value, baselineLabel) {
  if (Math.abs(value) < 1) return `Matches ${baselineLabel}`;
  return `${money(Math.abs(value))} ${value > 0 ? "lower" : "higher"} vs ${baselineLabel}`;
}

function setOutputValues() {
  for (const [input, output, , format] of inputs) $(output).textContent = format(Number($(input).value));
}

function renderHeadline(best, comparison, label) {
  const launches = best.allocations.filter((part) => part.qualificationQuarter);
  $("hero-plan").textContent = launches.length ? `Qualify ${launches.length} new ${launches.length === 1 ? "supplier" : "suppliers"}` : "Use approved suppliers";
  $("hero-detail").textContent = launches.length ? launches.map((part) =>
    `${part.name} → ${origins[part.candidateCountry]} in Q${part.qualificationQuarter}`
  ).join(" · ") : "Adjust order shares across qualified lanes within the selected limits.";
  $("plan-comparison").textContent = `${money(best.expectedCost)} modeled annual cost vs ${money(comparison.expectedCost)} for ${label}.`;
  $("expected-cost").textContent = money(best.expectedCost);
  $("cost-delta").textContent = difference(comparison.expectedCost - best.expectedCost, label);
  $("tail-cost").textContent = money(best.cvar95);
  $("tail-delta").textContent = difference(comparison.cvar95 - best.cvar95, label);
  $("qualification-cost").textContent = money(best.qualificationCost);
  $("qual-detail").textContent = `${best.qualificationSlots} of ${study.config.qualificationSlots} available slots`;
  $("working-capital").textContent = money(best.workingCapital);
  $("capital-detail").textContent = `Limit ${money(study.config.workingCapitalBudget)}`;
}

function costBar(cost, peak, className, description) {
  const row = element("div", undefined, "bar-row");
  row.setAttribute("aria-label", `${description} ${dollars.format(cost)}`);
  const track = element("div", undefined, "bar-track");
  track.setAttribute("aria-hidden", "true");
  const bar = element("div", undefined, `bar ${className}`);
  bar.style.width = `${100 * cost / peak}%`;
  track.append(bar);
  row.append(track, element("span", money(cost)));
  return row;
}

function renderScenarios(best, comparison) {
  const peak = Math.max(best.worstCost, comparison.worstCost);
  const rows = best.scenarioCosts.map((scenario, i) => {
    const row = element("div", undefined, "scenario");
    const label = element("div");
    label.append(element("span", scenario.name), element("small", `${percent.format(scenario.probability)} scenario weight`));
    const bars = element("div");
    bars.append(costBar(comparison.scenarioCosts[i].totalCost, peak, "baseline", comparison.label), costBar(scenario.totalCost, peak, "recommended", best.label));
    row.append(label, bars);
    return row;
  });
  $("scenario-chart").replaceChildren(...rows);
  $("shortage-detail").textContent = `Expected unfilled units ${quantity.format(best.expectedShortageUnits)} on the recommended plan, ${quantity.format(comparison.expectedShortageUnits)} on the comparison plan.`;
}

function renderSensitivity() {
  const { config, nextDecisionChange, sensitivity } = study;
  $("trigger").textContent = nextDecisionChange === null ? "No higher grid change" : `+${nextDecisionChange} pp`;
  $("trigger-detail").textContent = nextDecisionChange === null
    ? "The sampled higher tariff shocks keep the current order plan."
    : `The next sampled higher shock that changes at least one component policy. Current input +${config.tariffShock} pp.`;
  $("sensitivity").replaceChildren(...sensitivity.map((point) => {
    const tile = element("article", undefined, point.tariffShock === config.tariffShock ? "selected" : undefined);
    const delta = point.lockedExpected - point.optimizedExpected;
    tile.title = `${money(point.optimizedExpected)} expected cost. ${difference(delta, "current sourcing")}.`;
    tile.append(element("strong", `+${point.tariffShock} pp`), element("small", `${point.selectedPolicies} new`));
    return tile;
  }));
}

function renderAllocations() {
  if (!study) return;
  const quarter = Number($("quarter").value);
  const best = study.strategies.optimized;
  const comparison = study.strategies[$("baseline").value];
  $("quarter-column").textContent = `Q${quarter} orders`;
  $("quarter-summary").replaceChildren(...best.quarterly.map((entry) => {
    const button = element("button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(entry.quarter === quarter));
    const delta = comparison.quarterly[entry.quarter - 1].expectedCost - entry.expectedCost;
    button.append(element("span", `Q${entry.quarter}`), element("strong", money(entry.expectedCost)), element("small", difference(delta, "baseline")));
    button.addEventListener("click", () => {
      $("quarter").value = entry.quarter;
      renderAllocations();
      $("quarter-summary").children[entry.quarter - 1].focus();
    });
    return button;
  }));
  const rows = best.allocations.map((part, i) => {
    const row = element("tr");
    const component = element("td", part.name);
    component.append(element("small", `HS ${part.hts}`));
    const action = element("td", part.policy);
    if (part.qualificationQuarter) action.append(element("small", `${money(part.qualificationCost)} qualification · First eligible Q${part.firstQualifiedQuarter}`));
    const orders = element("td");
    for (const supplier of part.quarters[quarter - 1].suppliers) orders.append(element("div", `${supplier.country} ${quantity.format(supplier.units)} units (${percent.format(supplier.share)})`));
    const delta = comparison.allocations[i].expectedCost - part.expectedCost;
    row.append(component, action, orders, element("td", Math.abs(delta) < 1 ? "—" : `${money(Math.abs(delta))} ${delta > 0 ? "lower" : "higher"}`));
    return row;
  });
  $("allocation-table").tBodies[0].replaceChildren(...rows);
}

function renderStudy() {
  if (!study) return;
  const baseline = $("baseline").value;
  const { optimized } = study.strategies;
  const comparison = study.strategies[baseline];
  const label = baseline === "locked" ? "current sourcing" : "static plan";
  renderHeadline(optimized, comparison, label);
  renderScenarios(optimized, comparison);
  renderSensitivity();
  renderAllocations();
  renderLedger();
  $("policy-count").textContent = quantity.format(study.validation.candidatePolicies);
}

const costFields = [
  ["goods", "Goods"], ["freight", "Freight"], ["duties", "Duties"], ["contingency", "Emergency sourcing premium"],
  ["shortagePenalty", "Shortage penalties"], ["qualificationCost", "Qualification"], ["holdingCost", "Inventory carry"],
];

function renderLedger() {
  if (!study) return;
  const { optimized } = study.strategies;
  const comparison = study.strategies[$("baseline").value];
  const id = $("ledger-scenario").value;
  const expected = id === "expected";
  const left = expected ? comparison.breakdown : comparison.scenarioCosts.find((scenario) => scenario.id === id);
  const right = expected ? optimized.breakdown : optimized.scenarioCosts.find((scenario) => scenario.id === id);
  const baseTotal = expected ? comparison.expectedCost : left.totalCost;
  const planTotal = expected ? optimized.expectedCost : right.totalCost;
  const shortage = expected ? optimized.expectedShortageUnits : right.shortageUnits;
  $("ledger-summary").replaceChildren(...[
    ["Plan cost", money(planTotal)],
    ["Cost difference", difference(baseTotal - planTotal, "comparison")],
    ["Unfilled units", quantity.format(shortage)],
  ].map(([label, value]) => {
    const card = element("article");
    card.append(element("span", label), element("strong", value));
    return card;
  }));
  $("ledger-table").replaceChildren(evidenceTable(
    ["Cost driver", "Comparison", "Plan", "Plan minus comparison"],
    [...costFields.map(([key, label]) => [label, money(left[key]), money(right[key]), money(right[key] - left[key])]),
      ["Total", money(baseTotal), money(planTotal), money(planTotal - baseTotal)]],
  ));
}

function evidenceTable(headers, rows) {
  const wrapper = element("div", undefined, "table-scroll");
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute("aria-label", headers.join(", "));
  const table = element("table");
  const heading = table.createTHead().insertRow();
  for (const text of headers) {
    const cell = element("th", text);
    cell.scope = "col";
    heading.append(cell);
  }
  const body = table.createTBody();
  for (const record of rows) {
    const row = body.insertRow();
    for (const value of record) row.append(element("td", value ?? "—"));
  }
  wrapper.append(table);
  return wrapper;
}

function evidenceLink(text, url) {
  const link = element("a", text);
  link.href = url;
  const paragraph = element("p", undefined, "source-line");
  paragraph.append(link);
  return paragraph;
}

function codeDigits(code) {
  return code.replace(/[^0-9]/g, "");
}

async function getChapter(chapter) {
  if (!chapters.has(chapter.code)) {
    const response = await fetch(chapter.path + assetVersion);
    if (!response.ok) throw new Error("Chapter download failed.");
    chapters.set(chapter.code, await response.json());
  }
  return chapters.get(chapter.code);
}

async function searchMarket() {
  if (!marketIndex) return;
  const token = ++marketSearch;
  const query = $("market-query").value.trim().toLowerCase();
  const numeric = /^[0-9.]+$/.test(query);
  const prefix = numeric ? codeDigits(query) : "";
  const chapterCode = numeric ? prefix.slice(0, 2) : $("market-chapter").value;
  const chapter = marketIndex.chapters.find(({ code }) => code === chapterCode);
  if (!chapter || query.length < 2) {
    $("market-status").textContent = "Choose an indexed chapter or enter its two-digit code.";
    $("market-results").replaceChildren();
    return;
  }
  $("market-chapter").value = chapter.code;
  $("market-status").textContent = `Searching chapter ${chapter.code}…`;
  $("market-results").replaceChildren();
  try {
    const data = await getChapter(chapter);
    if (token !== marketSearch) return;
    const releaseId = $("market-release").value;
    const releaseIndex = marketIndex.releases.findIndex(({ id }) => id === releaseId);
    const release = marketIndex.releases[releaseIndex];
    const earlier = marketIndex.releases[releaseIndex - 1];
    const previousRates = new Map();
    for (const line of data.releases[earlier?.id] ?? []) {
      const key = line.code + "|" + line.description;
      const rates = previousRates.get(key) ?? new Set();
      rates.add(line.general || "—");
      previousRates.set(key, rates);
    }
    const terms = query.split(/\s+/);
    const lines = (data.releases[releaseId] ?? []).filter((line) =>
      numeric ? codeDigits(line.code).startsWith(prefix) : terms.every((term) => line.description.toLowerCase().includes(term)));
    const shown = lines.slice(0, 40);
    const indexed = marketIndex.indexedObservations;
    $("market-status").textContent = `${quantity.format(lines.length)} matches in chapter ${chapter.code} · ${release.label} · ${quantity.format(indexed)} coded rows across all revisions.` +
      (lines.length > shown.length ? ` Showing the first ${shown.length}. Refine your search to narrow results.` : "");
    const rows = shown.map((line) => {
      const previous = previousRates.get(line.code + "|" + line.description);
      const general = line.general || "—";
      const difference = earlier && previous && !previous.has(general) ? [...previous].join(" / ") + " → " + general : "—";
      return [line.code, line.description, general, line.special || "—", line.column2 || "—", difference];
    });
    $("market-results").replaceChildren(
      ...(rows.length ? [evidenceTable(["HTS code", "Published description", "General", "Special", "Column 2", "General rate change"], rows)] : []),
      evidenceLink(release.label + " · USITC ↗", release.url),
    );
  } catch (error) {
    if (token === marketSearch) $("market-status").textContent = error.message;
  }
}

async function initializeMarket() {
  try {
    const response = await fetch("./data/hts-index.json" + assetVersion);
    if (!response.ok) throw new Error("The full schedule index is unavailable.");
    marketIndex = await response.json();
    $("market-chapter").replaceChildren(...marketIndex.chapters.map(({ code, label }) => new Option(`${code} · ${label}`, code)));
    $("market-release").replaceChildren(...marketIndex.releases.map(({ id, label }) => new Option(label, id)));
    $("market-release").value = marketIndex.releases.at(-1).id;
    $("market-release").disabled = false;
    $("market-chapter").disabled = false;
    await searchMarket();
  } catch (error) {
    $("market-status").textContent = error.message;
  }
}

$("market-search").addEventListener("submit", (event) => {
  event.preventDefault();
  searchMarket();
});
$("market-release").addEventListener("change", searchMarket);
$("market-chapter").addEventListener("change", () => {
  if (/^[0-9.]+$/.test($("market-query").value.trim())) $("market-query").value = $("market-chapter").value;
  searchMarket();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.altKey || event.ctrlKey || event.metaKey ||
    event.target.closest("input, select, textarea, button, [contenteditable]")) return;
  event.preventDefault();
  $("market-query").focus();
});

function renderTariffEvidence(family) {
  if (!schedule) return;
  const releases = schedule.releases.filter((release) => Array.isArray(release.families));
  const release = releases.find((row) => row.id === $("hts-release").value) ?? releases.at(-1);
  const matched = release?.families.find((row) => row.hs6 === family);
  if (!matched || !Array.isArray(matched.lines)) {
    $("evidence-status").textContent = `No retained USITC schedule lines for HS ${family} in this snapshot.`;
    $("evidence-table").replaceChildren(evidenceLink("USITC Harmonized Tariff Schedule", "https://hts.usitc.gov/"));
    return;
  }
  const total = Number(schedule.observations ?? release.observations);
  const label = release.label ?? release.date ?? release.id;
  $("evidence-status").textContent = `${label} · ${release.date ?? ""} · ${quantity.format(total)} source rows indexed across ${releases.length} releases. Showing up to 12 of ${quantity.format(matched.count ?? matched.lines.length)} lines matched to HS ${family}. Published rates are reference text.`;
  $("evidence-table").replaceChildren(
    evidenceTable(["Tariff line", "Description", "General", "Special", "Column 2"], matched.lines.slice(0, 12)
      .map((line) => [line.code, line.description, line.general || "—", line.special || "—", line.column2 || "—"])),
    evidenceLink("USITC Harmonized Tariff Schedule", "https://hts.usitc.gov/"),
  );
}

function renderImportEvidence(family) {
  if (!imports) return;
  const rows = imports.rows.filter((row) => row.hs6 === family && Number.isFinite(row.valueUsd));
  const periods = [...new Set(rows.map((row) => row.period))].sort();
  const reportingWindow = $("import-window").value;
  const latest = reportingWindow === "all" ? periods : periods.slice(-Number(reportingWindow));
  if (!latest.length) {
    $("imports-status").textContent = `No retained UN Comtrade import rows for HS ${family}.`;
    $("imports-trend").replaceChildren();
    $("imports-table").replaceChildren(evidenceLink("UN Comtrade", "https://comtradeplus.un.org/"));
    return;
  }
  const current = new Map();
  for (const row of rows) {
    if (!latest.includes(row.period)) continue;
    const code = String(row.partnerCode);
    current.set(code, (current.get(code) ?? 0) + row.valueUsd);
  }
  const partners = new Map(imports.partners.map(({ code, name }) => [String(code), name]));
  const world = [...partners].find(([code, name]) => code === "0" || name.toLowerCase() === "world")?.[0];
  const worldValue = current.get(world);
  const worldRows = rows.filter((row) => String(row.partnerCode) === world && latest.includes(row.period));
  const shown = [...current].filter(([code]) => code !== world).sort((a, b) => b[1] - a[1]);
  const frequency = latest[0].length === 4 ? "years" : "months";
  const [topCode, topValue] = shown[0] ?? [];
  const concentration = worldValue > 0 && topCode
    ? ` ${partners.get(topCode) ?? topCode} leads tracked origins at ${percent.format(topValue / worldValue)} of the world total.`
    : "";
  $("imports-status").textContent = `${quantity.format(imports.observations ?? imports.rows.length)} public observations in the snapshot. HS ${family} values shown for ${latest[0]} to ${latest.at(-1)} (${latest.length} reporting ${frequency}). ${worldValue ? `World total ${money(worldValue)}.` : "World total unavailable."}${concentration}`;
  const trend = $("imports-trend");
  if (worldRows.length > 1) {
    const chart = element("div", undefined, "trade-columns");
    chart.setAttribute("aria-label", "U.S. import values from all origins by period");
    chart.style.setProperty("--periods", worldRows.length);
    const max = Math.max(...worldRows.map((row) => row.valueUsd));
    for (const row of worldRows.toSorted((a, b) => a.period.localeCompare(b.period))) {
      const column = element("div", undefined, "trade-column");
      column.title = `${row.period} · ${money(row.valueUsd)}`;
      column.tabIndex = 0;
      column.setAttribute("aria-label", column.title);
      const bar = element("span");
      bar.style.height = `${max > 0 ? 100 * row.valueUsd / max : 0}%`;
      column.append(bar);
      chart.append(column);
    }
    trend.replaceChildren(element("p", `World imports by reporting period, ${latest[0]} to ${latest.at(-1)}`), chart);
  } else {
    trend.replaceChildren();
  }
  $("imports-table").replaceChildren(
    evidenceTable(["Selected origin", "Reported U.S. imports", "Share of world total"], shown.map(([code, value]) => [partners.get(code) ?? code, money(value), worldValue ? percent.format(value / worldValue) : "—"])),
    evidenceLink("UN Comtrade", "https://comtradeplus.un.org/"),
  );
}

function renderEvidence() {
  const family = $("trade-family").value;
  if (!family) return;
  renderTariffEvidence(family);
  renderImportEvidence(family);
}

async function loadEvidence(path, validate, receive, status, table, link) {
  try {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!validate(data)) throw new Error("Unexpected data format");
    receive(data);
    renderEvidence();
  } catch {
    $(status).textContent = "This archived snapshot is currently unavailable. The modeled decision study is ready to run.";
    $(table).replaceChildren(link);
  }
}

function executeStudy() {
  if (pendingRun || loadingSample) return;
  pendingRun = true;
  appliedBuyerVersion = buyerRead;
  runCompanyCase = pendingCompanyCase ? structuredClone(pendingCompanyCase) : undefined;
  $("run-study").disabled = true;
  $("run-sample").disabled = true;
  $("run-status").textContent = "Evaluating sourcing policies…";
  $("results").setAttribute("aria-busy", "true");
  updateCompanyControls();
  const config = Object.fromEntries(inputs.map(([id, , key]) => [key, Number($(id).value)]));
  worker.postMessage({ ...config, buyer });
}

function finishStudy(error) {
  pendingRun = false;
  $("run-study").disabled = false;
  $("run-sample").disabled = false;
  $("results").setAttribute("aria-busy", "false");
  updateCompanyControls();
  if (error) $("run-status").textContent = "Optimization failed. " + error;
}

worker.addEventListener("message", ({ data }) => {
  finishStudy(data.error);
  if (data.error) return;
  study = data.study;
  appliedCompanyCase = runCompanyCase;
  renderCompanyCaseStatus();
  if (appliedBuyerVersion === buyerRead) {
    const { name, componentCount } = study.buyer;
    $("buyer-status").textContent = `${name} · ${componentCount} ${componentCount === 1 ? "component" : "components"} applied.`;
  }
  const selectedScenario = $("ledger-scenario").value;
  $("ledger-scenario").replaceChildren(new Option("Probability-weighted year", "expected"),
    ...study.scenarios.map(({ id, name }) => new Option(name, id)));
  if (study.scenarios.some(({ id }) => id === selectedScenario)) $("ledger-scenario").value = selectedScenario;
  const selectedFamily = $("trade-family").value;
  const families = new Map();
  for (const { hts, name } of study.components) families.set(hts, name);
  for (const { hs6 } of schedule?.releases.at(-1)?.families ?? []) if (!families.has(hs6)) families.set(hs6, "Market reference");
  $("trade-family").replaceChildren(...[...families].map(([hts, name]) => new Option(`${name} · ${hts}`, hts)));
  if (families.has(selectedFamily)) $("trade-family").value = selectedFamily;
  $("trade-family").disabled = false;
  renderStudy();
  renderEvidence();
  $("export-audit").disabled = false;
  $("export-memo").disabled = false;
  $("run-status").textContent = `${quantity.format(study.validation.feasibleTransitions)} feasible transitions checked.`;
});
worker.addEventListener("error", () => finishStudy("The calculation worker could not start. Reload to retry."));

$("run-sample").addEventListener("click", async () => {
  if (pendingRun || loadingSample) return;
  const version = ++buyerRead;
  loadingSample = true;
  $("run-sample").disabled = true;
  $("run-study").disabled = true;
  $("buyer-status").textContent = "Loading sample buyer…";
  let ready = false;
  try {
    const response = await fetch("./data/buyer.example.json");
    if (!response.ok) throw new Error("The sample file is unavailable.");
    const sample = validateBuyer(await response.json());
    if (version === buyerRead) {
      buyer = sample;
      pendingCompanyCase = undefined;
      $("buyer-status").textContent = `${buyer.name} · running with current assumptions.`;
      $("reset-buyer").disabled = false;
      ready = true;
    }
  } catch (error) {
    if (version === buyerRead) $("buyer-status").textContent = `Could not load sample buyer. ${error.message}`;
  } finally {
    loadingSample = false;
    if (ready) executeStudy();
    else finishStudy();
  }
});

$("buyer-file").addEventListener("change", async (event) => {
  const version = ++buyerRead;
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error("Use a buyer JSON file under 1 MB.");
    const verified = validateBuyer(JSON.parse(await file.text()));
    if (version !== buyerRead) return;
    buyer = verified;
    pendingCompanyCase = undefined;
    $("buyer-status").textContent = `${buyer.name} · ${buyer.components.length} components. Run optimization to apply.`;
    $("reset-buyer").disabled = false;
  } catch (error) {
    if (version === buyerRead) $("buyer-status").textContent = `File rejected. ${error.message}`;
  } finally {
    if (version === buyerRead) event.target.value = "";
  }
});

$("reset-buyer").addEventListener("click", () => {
  buyerRead++;
  buyer = undefined;
  pendingCompanyCase = undefined;
  $("buyer-file").value = "";
  $("buyer-status").textContent = "Representative industrial buyer. Run optimization to apply.";
  $("reset-buyer").disabled = true;
});

for (const [id] of inputs) $(id).addEventListener("input", () => {
  setOutputValues();
  $("run-status").textContent = "Inputs changed. Run optimization to update the plan.";
});
$("study-form").addEventListener("submit", (event) => {
  event.preventDefault();
  executeStudy();
});
$("baseline").addEventListener("change", renderStudy);
$("quarter").addEventListener("change", renderAllocations);
$("ledger-scenario").addEventListener("change", renderLedger);
$("trade-family").addEventListener("change", renderEvidence);
$("hts-release").addEventListener("change", renderEvidence);
$("import-window").addEventListener("change", () => renderImportEvidence($("trade-family").value));

function downloadFile(text, type, name) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = element("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("export-audit").addEventListener("click", () => {
  if (!study) return;
  const audit = {
    schemaVersion: 1, exportedAt: new Date().toISOString(),
    selectedBaseline: $("baseline").value, selectedQuarter: Number($("quarter").value),
    evidence: { tariffSchedule: schedule?.source ?? null, tariffRows: schedule?.observations ?? null, importSource: imports?.source ?? null, importRows: imports?.observations ?? null },
    companyCase: appliedCompanyCase ?? null,
    ...study,
  };
  downloadFile(JSON.stringify(audit, null, 2) + "\n", "application/json", "tariff-sourcing-audit.json");
});
$("export-memo").addEventListener("click", () => {
  if (!study) return;
  let memo = boardMemo(study, $("baseline").value);
  if (appliedCompanyCase) {
    const { ticker, basis, assumptions, normalizedGoodsSpend, limitations } = appliedCompanyCase;
    const manual = basis.kind === "user-entered";
    const anchor = manual
      ? `${ticker}: the user-entered annual planning budget of ${dollars.format(basis.value)} anchors this case. No reported company financial total is used; the company-total scope percentage is not applied.`
      : `${ticker}: the reported annual ${basis.label ?? basis.id} of ${dollars.format(basis.value)} for the period ending ${basis.end} anchors an estimated sourcing envelope. ${basis.selectionReason ?? ""}\n\nSource: ${basis.url}`;
    memo += `\n## Company planning case\n\n${anchor}\n\nAnalyst assumptions: ${manual ? "" : `${assumptions.scopePercent}% of the company total in scope, `}${assumptions.importSharePercent}% imported share, ${dollars.format(assumptions.averageUnitCost)} average goods unit cost, ${dollars.format(assumptions.qualificationCost)} qualification per prospective supplier, ${assumptions.primaryCountry} incumbent origin and ${assumptions.candidateCountry} prospective origin. The normalized representative basket contains ${dollars.format(normalizedGoodsSpend)} of annual goods at incumbent prices.\n\n${limitations.join("\n\n")}\n`;
  }
  downloadFile(memo, "text/markdown", "sourcing-decision-memo.md");
});

setOutputValues();
executeStudy();
initializeMarket();
initializeCompanies();
loadEvidence("./data/hts-snapshot.json" + assetVersion, (data) => Array.isArray(data.releases) && data.releases.length > 0, (data) => {
  schedule = data;
  $("hts-release").replaceChildren(...schedule.releases.map((release) => {
    const option = element("option", release.label ?? release.date);
    option.value = release.id;
    return option;
  }));
  $("hts-release").value = schedule.releases.at(-1).id;
  $("hts-release").disabled = false;
},
  "evidence-status", "evidence-table", evidenceLink("USITC Harmonized Tariff Schedule", "https://hts.usitc.gov/"));
loadEvidence("./data/imports.json" + assetVersion, (data) => Array.isArray(data.rows) && Array.isArray(data.partners), (data) => {
  imports = data;
  $("import-window").disabled = false;
},
  "imports-status", "imports-table", evidenceLink("UN Comtrade", "https://comtradeplus.un.org/"));
