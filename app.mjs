import { validateBuyer } from "./buyer.mjs?v=2";
import { boardMemo } from "./memo.mjs?v=1";

const $ = (id) => document.getElementById(id);
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
    const response = await fetch(chapter.path);
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
    const response = await fetch("./data/hts-index.json");
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
  const latest = periods.slice(-Number($("import-window").value));
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
  if (pendingRun) return;
  pendingRun = true;
  $("run-study").disabled = true;
  $("run-status").textContent = "Evaluating sourcing policies…";
  $("results").setAttribute("aria-busy", "true");
  const config = Object.fromEntries(inputs.map(([id, , key]) => [key, Number($(id).value)]));
  worker.postMessage({ ...config, buyer });
}

function finishStudy(error) {
  pendingRun = false;
  $("run-study").disabled = false;
  $("results").setAttribute("aria-busy", "false");
  if (error) $("run-status").textContent = "Optimization failed. " + error;
}

worker.addEventListener("message", ({ data }) => {
  finishStudy(data.error);
  if (data.error) return;
  study = data.study;
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

$("buyer-file").addEventListener("change", async (event) => {
  const version = ++buyerRead;
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error("Use a buyer JSON file under 1 MB.");
    const verified = validateBuyer(JSON.parse(await file.text()));
    if (version !== buyerRead) return;
    buyer = verified;
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
    ...study,
  };
  downloadFile(JSON.stringify(audit, null, 2) + "\n", "application/json", "tariff-sourcing-audit.json");
});
$("export-memo").addEventListener("click", () => {
  if (study) downloadFile(boardMemo(study, $("baseline").value), "text/markdown", "sourcing-decision-memo.md");
});

setOutputValues();
executeStudy();
initializeMarket();
loadEvidence("./data/hts-snapshot.json", (data) => Array.isArray(data.releases) && data.releases.length > 0, (data) => {
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
loadEvidence("./data/imports.json?v=2", (data) => Array.isArray(data.rows) && Array.isArray(data.partners), (data) => {
  imports = data;
  $("import-window").disabled = false;
},
  "imports-status", "imports-table", evidenceLink("UN Comtrade", "https://comtradeplus.un.org/"));
