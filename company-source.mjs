const remoteBase = "https://raw.githubusercontent.com/alexsergeev1/tariff-sourcing-optimizer/company-data/";
const version = new URL(import.meta.url).search;
const tickerPattern = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;

async function readJson(url, signal) {
  const timeout = AbortSignal.timeout(9000);
  const response = await fetch(url, { cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error("Company data request failed (" + response.status + ").");
  return response.json();
}

async function onlineOrBundled(path, validate, signal) {
  let payload;
  try {
    payload = await readJson(remoteBase + path, signal);
    if (!validate(payload)) throw new Error("Invalid online company data.");
    return { ...payload, delivery: "online" };
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  payload = await readJson(new URL("./" + path + version, import.meta.url), signal);
  if (!validate(payload)) throw new Error("The company snapshot could not be verified.");
  return { ...payload, delivery: "bundled" };
}

export async function loadCompanyIndex({ signal } = {}) {
  return onlineOrBundled("data/companies-index.json", (data) =>
    data?.schemaVersion === 1 && Array.isArray(data.companies) &&
    data.companies.every((company) => typeof company.name === "string" &&
      tickerPattern.test(company.ticker) && /^\d{1,10}$/.test(String(company.cik))), signal);
}

export async function loadCompanySnapshot(entry, { signal } = {}) {
  if (!entry || !tickerPattern.test(entry.ticker) || !entry.hasSnapshot) {
    throw new Error("This company has no financial snapshot. Open its SEC filings or enter your own case assumptions.");
  }
  const path = "data/companies/" + entry.ticker + ".json";
  return onlineOrBundled(path, (data) => data?.schemaVersion === 1 &&
    Number(data.profile?.cik) === Number(entry.cik) &&
    (data.profile?.ticker === entry.ticker || data.profile?.tickers?.includes(entry.ticker)) &&
    Array.isArray(data.facts), signal);
}
