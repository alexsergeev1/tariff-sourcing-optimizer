# Tariff Sourcing Optimizer

A four-quarter capital planning tool for a representative industrial buyer. It selects order shares, supplier qualifications, and start quarters across ten component families under shared engineering and cash limits. See the [live decision model](https://alexsergeev1.github.io/tariff-sourcing-optimizer/).

## Try it

1. Set the tariff shock, qualification budget, working capital, and adverse-regime weight, then run the optimization.
2. Compare the plan with current sourcing or the cheapest static plan across six scenarios. Inspect each quarter's orders, first delivery dates, and the next sampled tariff shock that changes the plan.
3. Explore archived U.S. tariff schedules and reported import flows for the same product families. Export the model inputs and full cost ledgers as JSON or download the decision memo.

Run locally with `node serve.mjs` and open [the local demo](http://127.0.0.1:4177/). Run `node --test` for the ledger, budget, delay, and sensitivity tests.

## Decision model

- The optimizer evaluates qualified supplier shares, qualification timing, lead time, and ramp capacity on a discrete quarterly schedule. Emergency orders can use remaining approved capacity at an assumed premium. Unfilled demand receives an explicit modeled penalty.
- Multiple-choice dynamic programming searches all feasible combinations of enumerated plans. The limits cover qualification spend, number and timing of qualification starts, and incremental pipeline cash. Pipeline cash uses the sum of positive component-level peak changes, rounded up in $25,000 increments for feasibility.
- The objective blends expected cost with average cost conditional on three adverse regimes. The portfolio's 95% tail cost, expected shortfall in units, and scenario-specific ledgers are reported separately. Current sourcing and the cheapest static plan are replayed against the same modeled scenarios.
- The default case models approximately $373.44M in expected planning cost versus $376.26M for the current sourcing plan and $377.60M for the cheapest static plan. These estimates include freight, modeled duties, shortage penalties, qualification, and inventory carry.

The public evidence panel shows published USITC schedules and national U.S. import observations. The buyer, supplier prices, contracts, effective duties, and scenario probabilities are synthetic. Project results are modeled planning comparisons. See [data and provenance](DATA.md) for the sources and refresh procedure.
