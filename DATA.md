# Data provenance

Run `node ingest.mjs --hts-only` to rebuild the tariff archive. Run `node ingest.mjs --trade-only --full-history --resume` to extend a trade snapshot or skip complete months already in it. Omit `--resume` to redownload the whole period. The script uses Node.js 22+ and requires no API key. The public preview API limits requests, so downloads are sequential and only complete years are published to the snapshot.

| Dataset | Source and transformation |
| --- | --- |
| `data/hts-snapshot.json` | [USITC Harmonized Tariff Schedule archive](https://www.usitc.gov/harmonized_tariff_information/hts/archive/list). Reads three fixed revisions dated April 15, 2025, December 5, 2025, and October 30, 2026. Counts the complete archive rows, retains the ten six-digit families used in the case study and exposes verbatim tariff expressions with presentation markup stripped. |
| `data/hts-index.json` and `data/hts/chapter-*.json` | Indexes 89,896 coded schedule rows across all three releases and 98 chapters. Each chapter file preserves the source order and repeated codes. The 107,891 raw-row count also includes uncoded headings and explanatory rows. |
| `data/imports.json` | [UN Comtrade](https://comtradeplus.un.org/). The committed snapshot has 3,947 U.S.-reported monthly import observations from January 2023 to December 2025, at HS6 by selected partner and world. Selects total transport, customs procedures, and secondary partner. Stores nominal U.S. dollars from the `primaryValue` field. |

The schedule explorer is a versioned reference. Its columns show the rate expressions published for individual classifications. A product description and origin alone do not establish applicable duties, preferences, exceptions, or Chapter 99 interactions. The optimizer instead takes explicit scenario tariff inputs and applies them to a modeled company's own selected quotes and orders.

UN Comtrade observations describe aggregate market trade, not a particular company's purchase prices or supplier capacity. Selected partners are a subset of the world total. Some public rows are calculated aggregates, and absent rows stay absent. None of those observations is an invoice, supplier quote, product classification ruling, or negotiated contract.

Run `node check-sources.mjs` to compare the bundled editions with the current USITC release and the most recent U.S. monthly dataset listed by UN Comtrade. The scheduled workflow publishes check metadata to `source-status`. The market observations and tariff archive require a separate ingestion run to refresh.
