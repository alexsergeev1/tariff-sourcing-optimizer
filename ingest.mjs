import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const directory = new URL("./data/", import.meta.url);
const archive = "https://www.usitc.gov/harmonized_tariff_information/hts/archive/list";
const releaseBase = "https://www.usitc.gov/sites/default/files/tata/hts/";
const releases = [
  { id: "2025-r10", label: "2025 Revision 10", date: "2025-04-15", file: "hts_2025_revision_10_json.json" },
  { id: "2025-r32", label: "2025 Revision 32", date: "2025-12-05", file: "hts_2025_revision_32_json.json" },
  { id: "2026-r22", label: "2026 Revision 22", date: "2026-10-30", file: "hts_2026_revision_22_json.json" },
  { id: "2026-r23", label: "2026 Revision 23", date: "2026-11-10", file: "hts_2026_revision_23_json.json" },
];
const familyCodes = ["850440", "853710", "854231", "850152", "841459", "848180", "848210", "854442", "853650", "761699"];
const partners = [
  [0, "World"], [124, "Canada"], [156, "China"], [276, "Germany"], [356, "India"], [392, "Japan"],
  [410, "Republic of Korea"], [458, "Malaysia"], [484, "Mexico"], [490, "Other Asia, nes"],
  [704, "Viet Nam"], [764, "Thailand"],
].map(([code, name]) => ({ code, name }));
const comtrade = "https://comtradeapi.un.org/public/v1/preview/C/M/HS";
const tradeThrough = "2026-08";
const partnerCodes = new Set(partners.map(({ code }) => code));

async function getJson(url, timeout = 60_000) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (response.ok) return response.json();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 5) {
      throw new Error(`${response.status} fetching ${url}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    await delay(retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 2500);
  }
}

function toPlainText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

function rateLine(row) {
  return {
    code: String(row.htsno ?? "").trim(),
    description: toPlainText(row.description),
    general: toPlainText(row.general),
    special: toPlainText(row.special),
    column2: toPlainText(row.other),
  };
}

async function downloadRelease({ file, ...release }) {
  const url = releaseBase + file;
  const data = await getJson(url);
  if (!Array.isArray(data) || data.length < 30_000) throw new Error("Incomplete HTS release: " + release.id);
  const families = new Map(familyCodes.map((hs6) => [hs6, []]));
  const chapters = new Map();
  let indexedObservations = 0;
  for (const row of data) {
    const code = String(row.htsno ?? "").trim();
    const digits = code.replaceAll(".", "");
    if (!/^\d{4,10}$/.test(digits)) continue;
    const chapter = digits.slice(0, 2);
    const line = rateLine(row);
    if (!chapters.has(chapter)) chapters.set(chapter, []);
    chapters.get(chapter).push(line);
    families.get(digits.slice(0, 6))?.push(line);
    indexedObservations++;
  }
  const groups = [...families].map(([hs6, lines]) => ({ hs6, count: lines.length, lines }));
  if (groups.some(({ count }) => !count)) throw new Error("Requested family missing from " + release.id);
  if (chapters.size < 95 || indexedObservations < 10_000) throw new Error("Incomplete chapter index: " + release.id);
  return {
    snapshot: {
      ...release,
      url,
      observations: data.length,
      indexedObservations,
      matchedObservations: groups.reduce((sum, group) => sum + group.count, 0),
      chapter99Rows: chapters.get("99")?.length ?? 0,
      families: groups,
    },
    chapters,
  };
}

async function tariffSchedules() {
  const downloads = await Promise.all(releases.map(downloadRelease));
  const snapshots = downloads.map(({ snapshot }) => snapshot);
  const observations = snapshots.reduce((sum, release) => sum + release.observations, 0);
  const indexedObservations = snapshots.reduce((sum, release) => sum + release.indexedObservations, 0);
  const chapterDirectory = new URL("hts/", directory);
  await mkdir(chapterDirectory, { recursive: true });
  const codes = [...new Set(downloads.flatMap(({ chapters }) => [...chapters.keys()]))].sort();
  const chapters = await Promise.all(codes.map(async (code) => {
    const filename = "chapter-" + code + ".json";
    const versions = Object.fromEntries(downloads.map(({ snapshot, chapters }) => [
      snapshot.id, chapters.get(code) ?? [],
    ]));
    const observations = Object.values(versions).reduce((sum, rows) => sum + rows.length, 0);
    await writeFile(new URL(filename, chapterDirectory), JSON.stringify({ chapter: code, releases: versions }) + "\n");
    return { code, label: "Chapter " + code, path: "./data/hts/" + filename, observations };
  }));
  if (chapters.reduce((sum, chapter) => sum + chapter.observations, 0) !== indexedObservations) {
    throw new Error("Tariff chapter row counts do not reconcile");
  }
  const manifestReleases = snapshots.map(({ id, label, date, url, observations, indexedObservations }) =>
    ({ id, label, date, url, observations, indexedObservations }));
  await Promise.all([
    writeFile(new URL("hts-index.json", directory), JSON.stringify({
      source: archive, observations, indexedObservations, releases: manifestReleases, chapters,
    }) + "\n"),
    writeFile(new URL("hts-snapshot.json", directory), JSON.stringify({
      source: archive, observations, releases: snapshots,
    }) + "\n"),
  ]);
  console.log(`Parsed ${observations} USITC schedule records across ${snapshots.length} releases and indexed ${indexedObservations} coded rows across ${chapters.length} chapters.`);
}

function completeTradePeriod(rows, period) {
  const keys = new Set();
  for (const row of rows) {
    const key = row.hs6 + ":" + row.partnerCode;
    if (row.period !== period || !familyCodes.includes(row.hs6) || !partnerCodes.has(row.partnerCode) ||
        !Number.isFinite(row.valueUsd) || row.valueUsd < 0 || keys.has(key)) return false;
    keys.add(key);
  }
  return familyCodes.every((hs6) => keys.has(hs6 + ":0"));
}

async function downloadTradePeriod(period) {
  const sourcePeriod = period.replace("-", "");
  const url = new URL(comtrade);
  url.search = new URLSearchParams({
    period: sourcePeriod,
    reporterCode: "842",
    cmdCode: familyCodes.join(","),
    flowCode: "M",
    partnerCode: partners.map(({ code }) => code).join(","),
    partner2Code: "0",
    customsCode: "C00",
    motCode: "0",
    maxRecords: "500",
  });
  const { data } = await getJson(url, 22_000);
  if (!Array.isArray(data) || data.length >= 500) throw new Error("Missing or capped Comtrade month: " + period);
  const rows = data.map((row) => ({
    period: String(row.period).slice(0, 4) + "-" + String(row.period).slice(4),
    hs6: row.cmdCode,
    partnerCode: row.partnerCode,
    valueUsd: row.primaryValue,
  }));
  if (data.some((row) => row.reporterCode !== 842 || row.flowCode !== "M" ||
      row.partner2Code !== 0 || row.customsCode !== "C00" || row.motCode !== 0) ||
      !completeTradePeriod(rows, period)) {
    throw new Error("Unexpected, incomplete, or duplicate Comtrade observations for " + period);
  }
  return rows;
}

async function saveTradeSnapshot(destination, rows) {
  const temporary = new URL("imports.next.json", directory);
  const snapshot = {
    source: comtrade,
    sourceName: "UN Comtrade public preview API",
    reporter: "United States",
    start: rows[0].period,
    end: rows.at(-1).period,
    observations: rows.length,
    partners,
    rows,
  };
  try {
    await writeFile(temporary, JSON.stringify(snapshot) + "\n");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`Retained ${snapshot.observations} UN Comtrade observations from ${snapshot.start} to ${snapshot.end}.`);
}

async function imports() {
  const destination = new URL("imports.json", directory);
  const existing = new Map();
  const resume = process.argv.includes("--resume");
  if (resume) {
    const snapshot = JSON.parse(await readFile(destination, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "{}";
    }));
    if (snapshot.source === comtrade && Array.isArray(snapshot.rows) &&
        snapshot.partners?.map(({ code }) => code).join(",") === partners.map(({ code }) => code).join(",")) {
      for (const row of snapshot.rows) {
        if (!existing.has(row.period)) existing.set(row.period, []);
        existing.get(row.period).push(row);
      }
    }
  }
  const cachedMonths = [...existing.keys()].sort();
  const cachedEnd = cachedMonths.at(-1) ?? "";
  if (cachedEnd > tradeThrough) throw new Error("The saved trade snapshot already extends past " + tradeThrough);
  const includeHistory = process.argv.includes("--full-history") || (cachedMonths.length > 0 && cachedMonths[0] < "2025-01");
  const start = includeHistory ? "2023-01" : "2025-01";
  const rows = [];
  let fetched = 0;
  let checkpoint = "";
  const date = new Date(start + "-01T00:00:00Z");
  while (true) {
    const period = date.toISOString().slice(0, 7);
    if (period > tradeThrough) break;
    const cached = existing.get(period);
    if (cached && completeTradePeriod(cached, period)) {
      rows.push(...cached);
    } else {
      rows.push(...await downloadTradePeriod(period));
      fetched++;
      if (resume && period >= cachedEnd) {
        await saveTradeSnapshot(destination, rows);
        checkpoint = period;
      }
      await delay(600);
    }
    date.setUTCMonth(date.getUTCMonth() + 1);
  }
  if (!fetched) console.log("The verified saved trade snapshot already covers " + tradeThrough + ".");
  else if (checkpoint !== tradeThrough) await saveTradeSnapshot(destination, rows);
}

await mkdir(directory, { recursive: true });
const work = [];
if (!process.argv.includes("--trade-only")) work.push(tariffSchedules());
if (!process.argv.includes("--hts-only")) work.push(imports());
await Promise.all(work);
