import test from "node:test";
import assert from "node:assert/strict";
import { loadCompanyIndex, loadCompanySnapshot } from "./company-source.mjs";

const entry = { ticker: "CAT", cik: "0000018230", name: "Caterpillar Inc.", hasSnapshot: true };

test("an invalid online directory falls back to the verified bundled directory", async () => {
  const originalFetch = globalThis.fetch;
  const directory = { schemaVersion: 1, companies: [entry] };
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const online = String(url).startsWith("https:");
    return { ok: true, json: async () => online ? { ...directory, companies: [{ ...entry, cik: "invalid" }] } : directory };
  };
  try {
    const result = await loadCompanyIndex();
    assert.equal(result.delivery, "bundled");
    assert.equal(result.companies[0].cik, entry.cik);
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a wrong-company response is rejected before facts reach a selected case", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ schemaVersion: 1, profile: { cik: "320193", ticker: "AAPL" }, facts: [] }),
  });
  try {
    await assert.rejects(loadCompanySnapshot(entry), /could not be verified/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("canceling company selection stops the request without starting a fallback", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  };
  try {
    await assert.rejects(loadCompanySnapshot(entry, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
