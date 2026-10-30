import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const directoryUrl = "https://www.sec.gov/files/company_tickers_exchange.json";
const documentationUrl = "https://www.sec.gov/search-filings/edgar-application-programming-interfaces";
const defaultTickers = "AAPL CAT DE GE HON GM F NKE TSLA DELL HPQ WMT TGT JPM BAC WFC C NLY AGNC RITM BLK GS MS STT BNY SCHW COF AXP V MA TROW NTRS SEIC MCO SPGI MSCI CME ICE NDAQ EXC CEG GEV ETN JNJ BDX MDT SYK MSFT AMZN IBM ORCL PLTR TXN ADI ACN NVDA AMD INTC CSCO COST HD LOW KO PEP PG UPS FDX BA RTX LMT DUK NEE".split(" ");
const periodicForms = new Set(["10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "40-F", "40-F/A"]);
const metricDefinitions = [
  ["assets", "Assets", ["Assets"], ["Assets"], "instant"],
  ["liabilities", "Liabilities", ["Liabilities"], ["Liabilities"], "instant"],
  ["equity", "Stockholders' equity", ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], ["EquityAttributableToOwnersOfParent", "Equity"], "instant"],
  ["cash", "Cash and cash equivalents", ["CashAndCashEquivalentsAtCarryingValue"], ["CashAndCashEquivalents"], "instant"],
  ["inventory", "Inventories", ["InventoryNet"], ["Inventories"], "instant"],
  ["revenue", "Revenue", ["RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "Revenues", "SalesRevenueNet", "SalesRevenueGoodsNet", "RevenueFromContractWithCustomer"], ["Revenue"], "duration"],
  ["costOfRevenue", "Cost of revenue", ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold", "CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization"], ["CostOfSales"], "duration"],
  ["operatingIncome", "Operating income", ["OperatingIncomeLoss"], ["ProfitLossFromOperatingActivities"], "duration"],
  ["netIncome", "Net income", ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"], ["ProfitLossAttributableToOwnersOfParent", "ProfitLoss"], "duration"],
  ["operatingCashFlow", "Net cash from operating activities", ["NetCashProvidedByUsedInOperatingActivities"], ["CashFlowsFromUsedInOperatingActivities"], "duration"],
  ["longTermDebt", "Long-term debt", ["LongTermDebt", "LongTermDebtNoncurrent"], ["LongtermBorrowings"], "instant"],
  ["loans", "Loans and leases", ["LoansAndLeasesReceivableNetReportedAmount", "LoansAndLeasesReceivableNetOfDeferredIncome", "LoansAndLeasesReceivableNetOfDeferredIncomeAndAllowanceForCreditLosses", "FinancingReceivableRecordedInvestmentExcludingAccruedInterestAfterAllowanceForCreditLoss", "LoansAndLeasesReceivableNetOfDeferredIncomeAndAllowanceForCreditLoss"], [], "instant"],
  ["deposits", "Deposits", ["Deposits"], [], "instant"],
  ["interestIncome", "Interest income", ["InterestIncomeOperating", "InvestmentIncomeInterest", "InterestAndDividendIncomeOperating"], ["InterestRevenueCalculatedUsingEffectiveInterestMethod"], "duration"],
  ["netInterestIncome", "Net interest income", ["InterestIncomeExpenseNet"], [], "duration"],
  ["interestExpense", "Interest expense", ["InterestExpense", "InterestExpenseOperating", "InterestAndDebtExpense"], ["InterestExpense"], "duration"],
  ["mortgageLoans", "Mortgage loans", ["MortgageLoansOnRealEstate", "MortgageLoansOnRealEstateNetOfAllowanceForCreditLosses", "MortgageLoansHeldForSale"], [], "instant"],
  ["mortgageBackedSecurities", "Mortgage-backed securities", ["AvailableForSaleSecuritiesDebtSecuritiesMortgageBackedSecurities", "AvailableForSaleSecuritiesDebtSecuritiesMortgageBackedSecuritiesResidential", "HeldToMaturitySecuritiesDebtSecuritiesMortgageBackedSecurities"], [], "instant"],
  ["mortgageServicingRights", "Mortgage servicing rights", ["MortgageServicingRightsAtFairValue", "MortgageServicingRights"], [], "instant"],
];

function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--output", "--as-of", "--tickers", "--capture"].includes(key) || !args[i + 1]) {
      throw new Error("Use --output <directory>, --as-of YYYY-MM-DD, --tickers AAPL,CAT,..., or --capture <directory>");
    }
    options[key.slice(2)] = args[++i];
  }
  const asOf = options["as-of"] ?? new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || new Date(asOf).toISOString().slice(0, 10) !== asOf) {
    throw new Error("--as-of must be a valid YYYY-MM-DD date");
  }
  const tickers = options.tickers ? options.tickers.split(",").map((ticker) => ticker.trim().toUpperCase()) : defaultTickers;
  if (tickers.some((ticker) => !/^[A-Z0-9.-]{1,15}$/.test(ticker))) throw new Error("Invalid ticker");
  return { output: resolve(options.output ?? fileURLToPath(new URL("./data/", import.meta.url))), asOf,
    tickers: [...new Set(tickers)], capture: options.capture ? resolve(options.capture) : null };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveJson(path, value) {
  const temporary = path + ".next";
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function filingUrl(cik, accession, document) {
  const root = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/`;
  return document ? root + document : root + accession + "-index.html";
}

function periodicFilings(submissions, asOf) {
  const recent = submissions.filings?.recent;
  if (!Array.isArray(recent?.accessionNumber)) return [];
  return recent.accessionNumber.map((accession, i) => ({
    accession, form: recent.form[i], filed: recent.filingDate[i],
    periodEnd: recent.reportDate[i] || null,
    primaryDocument: recent.primaryDocument[i] || null,
    url: filingUrl(submissions.cik, accession, recent.primaryDocument[i]),
  })).filter(({ form, filed }) => periodicForms.has(form) && filed <= asOf)
    .sort((a, b) => b.filed.localeCompare(a.filed) || b.accession.localeCompare(a.accession)).slice(0, 5);
}

function normalizePoints(raw, cik, asOf, kind) {
  const periods = new Map();
  for (const row of raw) {
    if (!periodicForms.has(row.form) || typeof row.filed !== "string" || row.filed > asOf ||
        !/^\d{4}-\d{2}-\d{2}$/.test(row.end ?? "") || row.end > asOf ||
        !Number.isFinite(row.val) || !/^\d{10}-\d{2}-\d{6}$/.test(row.accn ?? "")) continue;
    const durationDays = row.start ? Math.round((Date.parse(row.end) - Date.parse(row.start)) / 86_400_000) + 1 : null;
    if (kind === "duration" && (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 400)) continue;
    if (kind === "instant" && row.start) continue;
    const point = {
      value: row.val, ...(row.start ? { start: row.start, durationDays } : {}), end: row.end,
      filed: row.filed, form: row.form, accession: row.accn, url: filingUrl(cik, row.accn),
      ...(row.frame ? { frame: row.frame } : {}),
    };
    const key = (row.start ?? "") + ":" + row.end;
    const previous = periods.get(key);
    if (!previous || point.filed > previous.filed || point.filed === previous.filed && point.accession > previous.accession) {
      periods.set(key, point);
    }
  }
  return [...periods.values()].sort((a, b) => b.end.localeCompare(a.end) ||
    (a.durationDays ?? 0) - (b.durationDays ?? 0) || b.filed.localeCompare(a.filed));
}

export function extractFacts(companyFacts, asOf) {
  const result = [];
  for (const [id, label, usGaap, ifrs, kind] of metricDefinitions) {
    const candidates = [];
    for (const [taxonomy, concepts] of [["us-gaap", usGaap], ["ifrs-full", ifrs]]) {
      for (const concept of concepts) {
        const source = companyFacts.facts?.[taxonomy]?.[concept];
        if (!source?.units?.USD) continue;
        const history = normalizePoints(source.units.USD, companyFacts.cik, asOf, kind);
        if (history.length) candidates.push({ taxonomy, concept, source, history });
      }
    }
    candidates.sort((a, b) => b.history[0].end.localeCompare(a.history[0].end));
    const selected = candidates[0];
    if (!selected) continue;
    const { taxonomy, concept, source, history } = selected;
    const annual = kind === "duration" ? history.find(({ durationDays }) => durationDays >= 330 && durationDays <= 400) : null;
    const quarterly = kind === "duration" ? history.find(({ durationDays }) => durationDays >= 70 && durationDays <= 110) : null;
    result.push({ id, label: source.label || label, taxonomy, concept, unit: "USD", kind,
      latest: history[0], ...(annual ? { annual } : {}), ...(quarterly ? { quarterly } : {}), history: history.slice(0, 48) });
  }
  return result;
}

export function createSnapshot(entry, submissions, companyFacts, asOf, retrievedAt) {
  const recentFilings = submissions ? periodicFilings(submissions, asOf) : [];
  return {
    schemaVersion: 1, asOf, retrievedAt,
    profileRetrievedAt: submissions ? retrievedAt : null,
    factsRetrievedAt: companyFacts ? retrievedAt : null,
    profile: {
      name: submissions?.name || entry.name, ticker: entry.ticker, cik: String(entry.cik).padStart(10, "0"),
      tickers: submissions?.tickers ?? [entry.ticker], exchanges: submissions?.exchanges ?? [entry.exchange].filter(Boolean),
      ...(submissions?.sic ? { sic: submissions.sic } : {}),
      ...(submissions?.sicDescription ? { sicDescription: submissions.sicDescription } : {}),
      ...(submissions?.fiscalYearEnd ? { fiscalYearEnd: submissions.fiscalYearEnd } : {}),
      ...(submissions?.website ? { website: submissions.website } : {}),
      ...(submissions?.description ? { description: submissions.description } : {}),
      ...(submissions?.stateOfIncorporation ? { stateOfIncorporation: submissions.stateOfIncorporation } : {}),
      ...(submissions?.addresses?.business ? { businessAddress: submissions.addresses.business } : {}),
    },
    latestFiling: recentFilings[0] ?? null, recentFilings,
    facts: companyFacts ? extractFacts(companyFacts, asOf) : [],
    sources: {
      submissions: `https://data.sec.gov/submissions/CIK${String(entry.cik).padStart(10, "0")}.json`,
      companyFacts: `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(entry.cik).padStart(10, "0")}.json`,
      documentation: documentationUrl,
    },
  };
}

export function transformCompany(entry, submissions, companyFacts, { asOf, retrievedAt = new Date().toISOString() }) {
  return createSnapshot(entry, submissions, companyFacts, asOf, retrievedAt);
}

export function transformDirectory(source) {
  const fields = source.fields;
  if (!Array.isArray(fields) || !Array.isArray(source.data) || source.data.length < 5_000) throw new Error("Incomplete SEC ticker directory");
  const companies = source.data.map((row) => Object.fromEntries(fields.map((field, i) => [field, row[i]])))
    .map(({ cik, name, ticker, exchange }) => ({ ticker, name, cik: String(cik).padStart(10, "0"), exchange }))
    .filter(({ ticker, cik, name }) => typeof ticker === "string" && /^\d{10}$/.test(cik) && typeof name === "string")
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (new Set(companies.map(({ ticker }) => ticker)).size !== companies.length) throw new Error("Duplicate SEC tickers");
  return companies;
}

export const companyMetricDefinitions = metricDefinitions;

async function refresh(options) {
  const retrievedAt = new Date().toISOString();
  const snapshotDirectory = resolve(options.output, "companies");
  await mkdir(snapshotDirectory, { recursive: true });
  const indexPath = resolve(options.output, "companies-index.json");
  const previous = await readJson(indexPath);
  const userAgent = process.env.SEC_USER_AGENT || "AlexSergeevPortfolio/1.0 contact https://github.com/alexsergeev1";
  const blockedRoutes = new Set();
  const captureTimes = new Map();
  async function request(url) {
    if (options.capture) {
      if (url === directoryUrl) {
        const path = resolve(options.capture, "company-tickers.json");
        const directory = await readJson(path);
        if (!directory) throw new Error("Missing official ticker directory capture");
        captureTimes.set(url, (await stat(path)).mtime.toISOString());
        return directory;
      }
      const cik = /CIK(\d{10})/.exec(url)?.[1];
      const suffix = url.includes("companyfacts") ? "facts" : "submissions";
      for (const filename of [`${cik}-${suffix}.json`, `${Number(cik)}-${suffix}.json`]) {
        const path = resolve(options.capture, filename);
        const data = await readJson(path);
        if (data) {
          captureTimes.set(url, (await stat(path)).mtime.toISOString());
          return data;
        }
      }
      throw new Error(`Missing official ${suffix} capture for CIK ${cik}`);
    }
    const route = url.includes("companyfacts") ? "companyFacts" : url.includes("/submissions/") ? "submissions" : "directory";
    if (blockedRoutes.has(route)) throw new Error("SEC access is unavailable for this API route");
    await delay(350);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent, Accept: "application/json", "Accept-Encoding": "gzip, deflate" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response.json();
      if ([403, 429].includes(response.status)) {
        blockedRoutes.add(route);
        throw new Error("SEC HTTP " + response.status);
      }
      if (![500, 502, 503, 504].includes(response.status) || attempt === 2) throw new Error("SEC HTTP " + response.status);
      await delay(Math.max(2_000 * (attempt + 1), Number(response.headers.get("retry-after")) * 1000 || 0));
    }
  }
  let companies = previous?.companies ?? [];
  let directoryStatus = "current";
  try {
    const source = await request(directoryUrl);
    companies = transformDirectory(source);
  } catch (error) {
    directoryStatus = "unavailable";
    console.warn("Ticker directory: " + error.message + ". Retaining the previous directory.");
  }
  if (!companies.length) throw new Error("SEC directory unavailable and no previous directory exists. No snapshots were changed.");
  const requested = new Set(options.tickers);
  for (const entry of companies) {
    const path = resolve(snapshotDirectory, entry.ticker + ".json");
    let snapshot = await readJson(path);
    if (snapshot && Number(snapshot.profile?.cik) !== Number(entry.cik)) snapshot = null;
    if (requested.has(entry.ticker)) {
      const cik = String(entry.cik).padStart(10, "0");
      let submissions = null;
      let companyFacts = null;
      const errors = [];
      for (const [name, url] of [["submissions", `https://data.sec.gov/submissions/CIK${cik}.json`], ["companyFacts", `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`]]) {
        try {
          const source = await request(url);
          if (Number(source.cik) !== Number(entry.cik)) throw new Error("Unexpected CIK");
          if (name === "submissions") submissions = source;
          else companyFacts = source;
        } catch (error) { errors.push(name + ": " + error.message); }
      }
      if (submissions || companyFacts) {
        const current = createSnapshot(entry, submissions, companyFacts, options.asOf, retrievedAt);
        if (submissions) current.profileRetrievedAt = captureTimes.get(current.sources.submissions) ?? retrievedAt;
        if (companyFacts) current.factsRetrievedAt = captureTimes.get(current.sources.companyFacts) ?? retrievedAt;
        if (!submissions && snapshot) {
          current.profile = snapshot.profile;
          current.latestFiling = snapshot.latestFiling;
          current.recentFilings = snapshot.recentFilings;
          current.profileRetrievedAt = Object.hasOwn(snapshot, "profileRetrievedAt") ? snapshot.profileRetrievedAt : snapshot.retrievedAt;
        }
        if (!companyFacts && snapshot) {
          current.facts = snapshot.facts;
          current.factsRetrievedAt = snapshot.facts.length ? snapshot.factsRetrievedAt ?? snapshot.retrievedAt : null;
        }
        snapshot = { ...current, status: errors.length ? "partial" : "current", errors,
          ...(options.capture ? { delivery: "official SEC JSON captured through browser" } : {}) };
        await saveJson(path, snapshot);
      } else if (snapshot) {
        snapshot = { ...snapshot, status: "stale", lastAttemptAt: retrievedAt, errors };
        await saveJson(path, snapshot);
      }
      console.log(entry.ticker + ": " + (snapshot?.status ?? "unavailable") + ", " + (snapshot?.facts.length ?? 0) + " reported metrics");
    }
    entry.hasSnapshot = Boolean(snapshot);
    entry.hasFinancials = Boolean(snapshot?.facts.length);
    entry.metricCount = snapshot?.facts.length ?? 0;
    entry.snapshotPath = snapshot ? "./data/companies/" + entry.ticker + ".json" : null;
    if (snapshot) {
      entry.snapshotAsOf = snapshot.asOf;
      entry.status = snapshot.status ?? "current";
    } else if (requested.has(entry.ticker)) {
      entry.status = "unavailable";
    }
  }
  await saveJson(indexPath, {
    schemaVersion: 1, asOf: options.asOf, retrievedAt, sourceUrl: directoryUrl,
    directoryRetrievedAt: directoryStatus === "current" ? captureTimes.get(directoryUrl) ?? retrievedAt : previous?.directoryRetrievedAt ?? previous?.retrievedAt ?? null,
    directoryStatus, count: companies.length, snapshotCount: companies.filter(({ hasSnapshot }) => hasSnapshot).length,
    companies,
  });
  console.log(`Saved ${companies.length} official ticker records and ${companies.filter(({ hasSnapshot }) => hasSnapshot).length} company snapshots.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  refresh(parseArguments(process.argv.slice(2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
