# Data provenance

Run `node ingest.mjs` to download public data and regenerate the compact browser snapshots. The script uses Node.js 22+ and requires no API key. Use `--hts-only` or `--trade-only` to refresh a single source. Add `--full-history` to request the 2023 and 2024 trade observations. The public preview API limits requests and the script writes only complete years.

| Dataset | Source and transformation |
| --- | --- |
| `data/hts-snapshot.json` | [USITC Harmonized Tariff Schedule archive](https://www.usitc.gov/harmonized_tariff_information/hts/archive/list). Reads three fixed revisions dated April 15, 2025, December 5, 2025, and October 30, 2026. Counts the complete archive rows, retains the ten six-digit families used in the case study and exposes verbatim tariff expressions with presentation markup stripped. |
| `data/imports.json` | [UN Comtrade](https://comtradeplus.un.org/). The committed snapshot has 1,316 U.S.-reported monthly import observations from January to December 2025, at HS6 by selected partner and world. Selects total transport, customs procedures, and secondary partner. Stores nominal U.S. dollars from the `primaryValue` field. |

The schedule explorer is a versioned reference. Its columns show the rate expressions published for individual classifications. A product description and origin alone do not establish applicable duties, preferences, exceptions, or Chapter 99 interactions. The optimizer instead takes explicit scenario tariff inputs and applies them to a modeled company's own selected quotes and orders.

UN Comtrade observations describe aggregate market trade, not a particular company's purchase prices or supplier capacity. Selected partners are a subset of the world total. Some public rows are calculated aggregates, and absent rows stay absent. None of those observations is an invoice, supplier quote, product classification ruling, or negotiated contract.
