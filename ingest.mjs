import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const directory = new URL("./data/", import.meta.url);
const archive = "https://www.usitc.gov/harmonized_tariff_information/hts/archive/list";
const releaseBase = "https://www.usitc.gov/sites/default/files/tata/hts/";
const releases = [
  { id: "2025-r10", label: "2025 Revision 10", date: "2025-04-15", file: "hts_2025_revision_10_json.json" },
  { id: "2025-r32", label: "2025 Revision 32", date: "2025-12-05", file: "hts_2025_revision_32_json.json" },
  { id: "2026-r22", label: "2026 Revision 22", date: "2026-10-30", file: "hts_2026_revision_22_json.json" },
];
const familyCodes = ["850440", "853710", "854231", "850152", "841459", "848180", "848210", "854442", "853650", "761699"];
const partners = [
  [0, "World"], [124, "Canada"], [156, "China"], [276, "Germany"], [356, "India"], [392, "Japan"],
  [410, "Republic of Korea"], [458, "Malaysia"], [484, "Mexico"], [490, "Other Asia, nes"],
  [704, "Viet Nam"], [764, "Thailand"],
].map(([code, name]) => ({ code, name }));
const comtrade = "https://comtradeapi.un.org/public/v1/preview/C/M/HS";

async function getJson(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
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

async function downloadTradePeriod(period) {
  const url = new URL(comtrade);
  url.search = new URLSearchParams({
    period: period.replace("-", ""),
    reporterCode: "842",
    cmdCode: familyCodes.join(","),
    flowCode: "M",
    partnerCode: partners.map(({ code }) => code).join(","),
    partner2Code: "0",
    customsCode: "C00",
    motCode: "0",
    maxRecords: "500",
  });
  const { data } = await getJson(url);
  if (!Array.isArray(data) || data.length >= 500) throw new Error("Missing or capped Comtrade month: " + period);
  const keys = new Set();
  const rows = [];
  for (const row of data) {
    if (!familyCodes.includes(row.cmdCode) || !Number.isFinite(row.primaryValue)) continue;
    const key = row.cmdCode + ":" + row.partnerCode;
    if (keys.has(key)) throw new Error(`Duplicate Comtrade record for ${period} ${key}`);
    keys.add(key);
    rows.push({ period, hs6: row.cmdCode, partnerCode: row.partnerCode, valueUsd: row.primaryValue });
  }
  if (rows.filter(({ partnerCode }) => partnerCode === 0).length !== familyCodes.length) {
    throw new Error("Comtrade world totals are incomplete for " + period);
  }
  return rows;
}

async function imports() {
  const years = process.argv.includes("--full-history") ? [2025, 2024, 2023] : [2025];
  const destination = new URL("imports.json", directory);
  const existing = new Map();
  if (process.argv.includes("--resume")) {
    const snapshot = JSON.parse(await readFile(destination, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "{}";
    }));
    if (snapshot.source === comtrade &&
        snapshot.partners?.map(({ code }) => code).join(",") === partners.map(({ code }) => code).join(",")) {
      for (const row of snapshot.rows) {
        if (!existing.has(row.period)) existing.set(row.period, []);
        existing.get(row.period).push(row);
      }
    }
  }
  const rows = [];
  for (const year of years) {
    const yearRows = [];
    let fetched = 0;
    for (let month = 1; month <= 12; month++) {
      const period = year + "-" + String(month).padStart(2, "0");
      const cached = existing.get(period);
      const world = cached?.filter(({ partnerCode }) => partnerCode === 0).map(({ hs6 }) => hs6);
      if (world?.length === familyCodes.length && familyCodes.every((code) => world.includes(code))) {
        yearRows.push(...cached);
        continue;
      }
      yearRows.push(...await downloadTradePeriod(period));
      fetched++;
      await delay(600);
    }
    rows.unshift(...yearRows);
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
    if (fetched > 0 || existing.size < new Set(rows.map(({ period }) => period)).size) {
      await writeFile(destination, JSON.stringify(snapshot) + "\n");
    }
    console.log(`Retained ${snapshot.observations} UN Comtrade observations from ${snapshot.start} to ${snapshot.end} (${fetched} new months in ${year}).`);
  }
}

await mkdir(directory, { recursive: true });
const work = [];
if (!process.argv.includes("--trade-only")) work.push(tariffSchedules());
if (!process.argv.includes("--hts-only")) work.push(imports());
await Promise.all(work);
