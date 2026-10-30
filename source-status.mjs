const card = document.getElementById("source-freshness");
const refresh = document.getElementById("source-refresh");
const result = document.getElementById("source-results");
const note = document.getElementById("source-checked");

const rawUrl = "https://raw.githubusercontent.com/" + card.dataset.repo + "/source-status/source-status.json";
const labels = { newer: "Newer data available", current: "Matches snapshot", unavailable: "Source unavailable" };

async function readStatus(url) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error("Source status unavailable.");
  const payload = await response.json();
  if (!Array.isArray(payload.sources) || !Number.isFinite(Date.parse(payload.checkedAt))) {
    throw new Error("Invalid source status.");
  }
  return payload;
}

function sourceRow(source) {
  const item = document.createElement("li");
  const name = document.createElement("a");
  const state = document.createElement("strong");
  const detail = document.createElement("small");
  const url = new URL(source.url);
  if (url.protocol === "https:") name.href = url.href;
  name.textContent = source.name;
  state.textContent = labels[source.status] ?? "Unknown status";
  detail.textContent = "Snapshot " + (source.snapshot ?? "—") + " · Latest " + (source.latest ?? "—");
  item.append(name, state, detail);
  return item;
}

async function showStatus() {
  refresh.disabled = true;
  note.textContent = "Reading the latest status report…";
  try {
    let cached = false;
    const payload = await readStatus(rawUrl).catch(() => {
      cached = true;
      return readStatus("./data/source-status.json");
    });
    result.replaceChildren(...payload.sources.map(sourceRow));
    const checked = new Date(payload.checkedAt).toLocaleString("en-US", { timeZone: "UTC" });
    const stale = Date.now() - Date.parse(payload.checkedAt) > 48 * 60 * 60 * 1000;
    note.textContent = (cached ? "Bundled check from " : "Online check from ") + checked + " UTC. " +
      (stale ? "This report is more than 48 hours old. " : "") + "The decision model uses the pinned snapshot.";
  } catch {
    note.textContent = "No status report is available yet. The pinned data remains available.";
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", showStatus);
showStatus();
