# Data provenance

Run `node ingest.mjs --hts-only` to rebuild the tariff archive. Run `node ingest.mjs --trade-only --full-history --resume` to extend a trade snapshot or skip complete months already in it. Omit `--resume` to redownload the full period. The script uses Node.js 22+ and requires no API key. Downloads from the rate-limited Comtrade preview API run sequentially. A resumed download saves each new month after checking the reporting dimensions, unique product and partner keys, and all ten world totals.

| Dataset | Source and transformation |
| --- | --- |
| `data/hts-snapshot.json` | [USITC Harmonized Tariff Schedule archive](https://www.usitc.gov/harmonized_tariff_information/hts/archive/list). Reads four fixed revisions dated April 15, 2025, December 5, 2025, October 30, 2026, and November 10, 2026. Counts the complete archive rows, retains the ten six-digit families used in the case study and exposes verbatim tariff expressions with presentation markup stripped. |
| `data/hts-index.json` and `data/hts/chapter-*.json` | Indexes 119,757 coded schedule rows across four releases and 98 chapters. Each chapter file preserves the source order and repeated codes. The 143,696 raw-row count also includes uncoded headings and explanatory rows. |
| `data/imports.json` | [UN Comtrade](https://comtradeplus.un.org/). The snapshot has 4,826 U.S.-reported monthly import observations from January 2023 to August 2026, at HS6 by selected partner and world. It uses all modes of transport, all customs procedures, and an aggregate secondary partner. Values come from the `primaryValue` field in nominal U.S. dollars. The [availability API](https://comtradeapi.un.org/public/v1/getDA/C/M/HS?reporterCode=842&period=202608) lists the August 2026 release date as October 30, 2026. |

The schedule explorer is a versioned reference. Its columns show the rate expressions published for individual classifications. A product description and origin alone do not establish applicable duties, preferences, exceptions, or Chapter 99 interactions. The optimizer instead takes explicit scenario tariff inputs and applies them to a modeled company's own selected quotes and orders.

UN Comtrade observations describe aggregate market trade, not a particular company's purchase prices or supplier capacity. Selected partners are a subset of the world total. Some public rows are calculated aggregates, and absent rows stay absent. None of those observations is an invoice, supplier quote, product classification ruling, or negotiated contract.

Run `node check-sources.mjs` to compare the bundled editions with the current USITC release and the most recent U.S. monthly dataset listed by UN Comtrade. The scheduled workflow publishes check metadata to `source-status`. The market observations and tariff archive require a separate ingestion run to refresh.
