import { runStudy } from "./engine.mjs?v=1";
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
  $("hero-detail").textContent = launches.length ? launches.map((part) => {
    const last = part.quarters.at(-1).suppliers.at(-1);
    return `${part.name} → ${origins[last.country]} in Q${part.qualificationQuarter}`;
  }).join(" · ") : "Adjust order shares across qualified lanes within the selected limits.";
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
    button.append(element("span", `Q${entry.quarter}`), element("strong", money(entry.expectedCost)));
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
  $("policy-count").textContent = quantity.format(study.validation.candidatePolicies);
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
  const latest = periods.slice(-12);
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
  $("imports-status").textContent = `${quantity.format(imports.observations ?? imports.rows.length)} public observations in the snapshot. HS ${family} values shown for ${latest[0]} to ${latest.at(-1)} (${latest.length} reporting ${frequency}). ${worldValue ? `World total ${money(worldValue)}.` : "World total unavailable."}`;
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
  $("run-study").disabled = true;
  $("run-status").textContent = "Evaluating sourcing policies…";
  $("results").setAttribute("aria-busy", "true");
  setTimeout(() => {
    try {
      const config = Object.fromEntries(inputs.map(([id, , key]) => [key, Number($(id).value)]));
      study = runStudy(config);
      renderStudy();
      if (!$("trade-family").options.length) {
        $("trade-family").replaceChildren(...study.components.map(({ hts, name }) => {
          const option = element("option", `${name} · ${hts}`);
          option.value = hts;
          return option;
        }));
        $("trade-family").disabled = false;
        renderEvidence();
      }
      $("export-audit").disabled = false;
      $("export-memo").disabled = false;
      $("run-status").textContent = `${quantity.format(study.validation.feasibleTransitions)} feasible transitions checked.`;
    } catch (error) {
      $("run-status").textContent = `Optimization failed. ${error.message}`;
    } finally {
      $("run-study").disabled = false;
      $("results").setAttribute("aria-busy", "false");
    }
  }, 0);
}

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
$("trade-family").addEventListener("change", renderEvidence);
$("hts-release").addEventListener("change", renderEvidence);

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
loadEvidence("./data/imports.json", (data) => Array.isArray(data.rows) && Array.isArray(data.partners), (data) => { imports = data; },
  "imports-status", "imports-table", evidenceLink("UN Comtrade", "https://comtradeplus.un.org/"));
