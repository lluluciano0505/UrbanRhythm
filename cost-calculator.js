#!/usr/bin/env node

/**
 * Cost Tracker for UrbanRhythm Scraper
 * 
 * Estimates monthly costs based on scraping activity
 */

const PRICING = {
  googleMaps: 0.007,           // per query
  openrouter: 0.00015,         // average per venue (gpt-4o-mini)
  jina: 0,                     // free
  perplexity: 0.001,           // average per venue (sonar)
};

function calculateMonthlyCost(config = {}) {
  const {
    venuesPerMonth = 1000,
    strategyAHitRate = 0.65,    // 65% of venues find events on Strategy A
    strategyBHitRate = 0.25,    // 25% need Strategy B
    strategyCHitRate = 0.10,    // 10% need Strategy C (Perplexity)
  } = config;

  const results = {
    googleMaps: {
      queries: venuesPerMonth,
      costPer: PRICING.googleMaps,
      total: venuesPerMonth * PRICING.googleMaps,
      description: "Places API searches"
    },
    jina: {
      calls: venuesPerMonth * 1.5,  // ~1.5 calls per venue on average
      costPer: PRICING.jina,
      total: 0,
      description: "HTML→Markdown conversions (Strategy A + B calls)"
    },
    openrouter: {
      calls: venuesPerMonth * (strategyAHitRate + strategyBHitRate),
      costPer: PRICING.openrouter,
      total: venuesPerMonth * (strategyAHitRate + strategyBHitRate) * PRICING.openrouter,
      description: "LLM extractions (Strategy A + B)"
    },
    perplexity: {
      calls: venuesPerMonth * strategyCHitRate,
      costPer: PRICING.perplexity,
      total: venuesPerMonth * strategyCHitRate * PRICING.perplexity,
      description: "Web searches (Strategy C fallback)"
    }
  };

  const monthlyTotal = 
    results.googleMaps.total + 
    results.openrouter.total + 
    results.perplexity.total;

  const yearlyTotal = monthlyTotal * 12;

  return {
    breakdown: results,
    monthlyTotal,
    yearlyTotal,
    costPerVenue: monthlyTotal / venuesPerMonth,
    summary: `
💰 Monthly Cost Estimate (${venuesPerMonth} venues)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Google Maps:     $${results.googleMaps.total.toFixed(2)}  (${results.googleMaps.queries} queries)
OpenRouter LLM:  $${results.openrouter.total.toFixed(2)}  (${results.openrouter.calls.toFixed(0)} extractions)
Perplexity:      $${results.perplexity.total.toFixed(2)}  (${results.perplexity.calls.toFixed(0)} searches)
Jina Reader:     $${results.jina.total.toFixed(2)}  (FREE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Monthly:   $${monthlyTotal.toFixed(2)}
Total Yearly:    $${yearlyTotal.toFixed(2)}
Cost per Venue:  $${(monthlyTotal / venuesPerMonth).toFixed(4)}

Hit Rates:
  Strategy A (Jina direct):    ${(strategyAHitRate * 100).toFixed(0)}%
  Strategy B (Sub-pages):      ${(strategyBHitRate * 100).toFixed(0)}%
  Strategy C (Web search):     ${(strategyCHitRate * 100).toFixed(0)}%
    `
  };
}

// Common scenarios
const scenarios = {
  "small": { venuesPerMonth: 100 },
  "medium": { venuesPerMonth: 500 },
  "large": { venuesPerMonth: 1000 },
  "enterprise": { venuesPerMonth: 5000 },
  "regex-only": {
    venuesPerMonth: 1000,
    strategyAHitRate: 0.40,
    strategyBHitRate: 0.60,
    strategyCHitRate: 0,  // No Perplexity
  }
};

console.log("🕷️  UrbanRhythm Cost Calculator\n");

if (process.argv[2]) {
  const scenario = scenarios[process.argv[2]];
  if (scenario) {
    const result = calculateMonthlyCost(scenario);
    console.log(result.summary);
  } else {
    console.error(`Unknown scenario. Available: ${Object.keys(scenarios).join(", ")}`);
  }
} else {
  // Show all scenarios
  console.log("Scenarios:\n");
  for (const [name, config] of Object.entries(scenarios)) {
    const result = calculateMonthlyCost(config);
    console.log(`\n📌 ${name.toUpperCase()}`);
    console.log(`   ${config.venuesPerMonth} venues/month`);
    console.log(`   Monthly: $${result.monthlyTotal.toFixed(2)} | Yearly: $${result.yearlyTotal.toFixed(2)}`);
  }
  console.log("\n\nUsage: node cost-calculator.js [scenario]");
  console.log("Example: node cost-calculator.js medium");
}

export { calculateMonthlyCost };
