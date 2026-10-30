const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const units = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function boardMemo(study, comparator = "locked") {
  const { config, strategies, recommendation, nextDecisionChange, validation } = study;
  const baseline = strategies[comparator];
  const plan = strategies.optimized;
  const difference = baseline.expectedCost - plan.expectedCost;
  const lines = [
    "# Sourcing decision memo",
    "",
    `Compare **${plan.label}** with **${baseline.label}** at a ${config.tariffShock} percentage point tariff shock.`,
    "",
    `Expected modeled annual cost is ${dollars.format(plan.expectedCost)} versus ${dollars.format(baseline.expectedCost)}. The modeled cost difference is ${dollars.format(difference)} in favor of the plan when positive.`,
    `The 95% tail mean cost is ${dollars.format(plan.cvar95)} versus ${dollars.format(baseline.cvar95)}. Expected shortfall is ${units.format(plan.expectedShortageUnits)} units versus ${units.format(baseline.expectedShortageUnits)}.`,
    "",
    "## Cash and qualification",
    "",
    `Qualification spend is ${dollars.format(plan.qualificationCost)} against a ${dollars.format(config.qualificationBudget)} budget. Incremental inventory cash is ${dollars.format(plan.workingCapital)}. The solver reserves ${dollars.format(plan.budgetedWorkingCapital)} after rounding against a ${dollars.format(config.workingCapitalBudget)} cap.`,
    "",
    "| Quarter | Baseline expected cost | Plan expected cost | Baseline minus plan | Qualification starts |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [i, quarter] of plan.quarterly.entries()) {
    const base = baseline.quarterly[i].expectedCost;
    lines.push(`| Q${quarter.quarter} | ${dollars.format(base)} | ${dollars.format(quarter.expectedCost)} | ${dollars.format(base - quarter.expectedCost)} | ${plan.qualificationStarts[i]} |`);
  }
  lines.push("", "## Actions", "");
  const starts = recommendation.filter((part) => part.qualificationQuarter)
    .sort((a, b) => a.qualificationQuarter - b.qualificationQuarter || a.name.localeCompare(b.name));
  if (!starts.length) lines.push("Retain current qualifications under the selected constraints.");
  for (const part of starts) {
    const end = part.quarters.at(-1).suppliers.map((lane) => `${lane.country} ${Math.round(100 * lane.share)}%`).join(", ");
    lines.push(`- **${part.name}.** Start qualification in Q${part.qualificationQuarter}, first qualified in Q${part.firstQualifiedQuarter}. The Q4 allocation is ${end}.`);
  }
  lines.push(
    "",
    nextDecisionChange == null
      ? "No allocation change was found at the higher shock points tested."
      : `The next higher sampled shock that changes the allocation is ${nextDecisionChange} percentage points.`,
    "",
    "## Evidence and scope",
    "",
    `The solver evaluated ${units.format(validation.candidatePolicies)} component policies. The buyer, contracts, supply scenarios, shortage penalties, and resulting savings are modeled. Public tariff and trade snapshots document market context.`,
    "",
  );
  return lines.join("\n");
}
