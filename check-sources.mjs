import { readFile, writeFile } from "node:fs/promises";

const readSnapshot = async (filename) => JSON.parse(await readFile(new URL("./data/" + filename, import.meta.url), "utf8"));
const [schedule, imports] = await Promise.all([readSnapshot("hts-snapshot.json"), readSnapshot("imports.json")]);
const bundled = schedule.releases.at(-1);

async function requestJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

function versionNumber(year, revision) {
  return Number(year) * 1000 + Number(revision);
}

async function latestSchedule() {
  const edition = await requestJson("https://hts.usitc.gov/reststop/currentRelease");
  const latest = /^(\d{4})HTS(?:Rev(\d+))?$/.exec(edition.name);
  const snapshot = /^(\d{4})-r(\d+)$/.exec(bundled.id);
  if (!latest || !snapshot || typeof edition.description !== "string") throw new Error("Unrecognized release");
  return {
    latest: edition.description,
    newer: versionNumber(latest[1], latest[2] ?? 0) > versionNumber(snapshot[1], snapshot[2]),
  };
}

function recentPeriods() {
  const today = new Date();
  return Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1))
      .toISOString().slice(0, 7).replace("-", ""));
}

async function latestImportMonth() {
  const url = new URL("https://comtradeapi.un.org/public/v1/getDA/C/M/HS");
  url.search = new URLSearchParams({ reporterCode: "842", period: recentPeriods().join(",") });
  const { data } = await requestJson(url);
  if (!Array.isArray(data)) throw new Error("Unexpected data availability response");
  const available = data.filter(({ reporterCode, freqCode, period, totalRecords }) =>
    reporterCode === 842 && freqCode === "M" && /^\d{6}$/.test(String(period)) && totalRecords > 0);
  if (!available.length) throw new Error("No recent U.S. months in the availability API");
  const stamp = String(Math.max(...available.map(({ period }) => Number(period))));
  const latest = stamp.slice(0, 4) + "-" + stamp.slice(4);
  return { latest, newer: latest > imports.end };
}

async function sourceStatus(name, url, snapshot, readLatest) {
  try {
    const { latest, newer } = await readLatest();
    return { name, url, snapshot, latest, status: newer ? "newer" : "current" };
  } catch (error) {
    console.warn(`${name}: ${error.message}`);
    return { name, url, snapshot, latest: null, status: "unavailable" };
  }
}

const sources = await Promise.all([
  sourceStatus("USITC Harmonized Tariff Schedule", schedule.source, bundled.label, latestSchedule),
  sourceStatus("UN Comtrade U.S. monthly imports", "https://comtradeplus.un.org/DataAvailability", imports.end, latestImportMonth),
]);
const output = JSON.stringify({ checkedAt: new Date().toISOString(), sources }, null, 2) + "\n";
if (process.argv[2]) await writeFile(process.argv[2], output);
process.stdout.write(output);
