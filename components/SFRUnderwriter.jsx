import { useState, useRef, useMemo, useCallback } from "react";

const MODEL = "claude-sonnet-4-20250514";

const DEFAULT_CRITERIA = {
  minMonthlyCashFlow: 200, minCapRate: 5.0, minCashOnCash: 6.0,
  minDSCR: 1.20, maxGRM: 18, maxBreakEven: 85,
  minAppreciation1yr: -2, maxVacancyRate: 10,
};
const DEFAULT_EXPENSE_OVERRIDES = {
  taxes: null, insurance: null, maintenance: null,
  management: null, vacancy: null, capex: null, hoa: null,
};
const DEFAULT_LOAN = { downPct: 25, rate: 7.5, termYears: 30 };

// DSCR Loan Lender Tiers — based on typical DSCR lender requirements (2024–2025 market)
// Lender DSCR = Gross Monthly Rent ÷ Monthly PITIA (P&I + Taxes + Insurance + HOA)
const DEFAULT_DSCR_CRITERIA = {
  tier1MinDscr:        1.25,   // Premium: best rates, most lenders, 75% LTV
  tier2MinDscr:        1.00,   // Standard: most DSCR lenders, 80% LTV
  tier3MinDscr:        0.75,   // No-ratio: limited lenders, 70% LTV, rate premium
  tier1MaxLtv:         75,     // % — Tier A max LTV
  tier2MaxLtv:         80,     // % — Tier B max LTV
  tier3MaxLtv:         70,     // % — Tier C max LTV (no-ratio)
  minPropertyValue:    100000, // $
  minLoanAmount:       75000,  // $ — most DSCR lenders won't go below this
  reservesMonths:      6,      // months of PITIA required in reserves
  ratePremiumTier1:    1.25,   // % above conventional (e.g. 7.5% conv → 8.75%)
  ratePremiumTier2:    1.75,   // % above conventional
  ratePremiumTier3:    2.50,   // % above conventional
  conventionalRate:    7.50,   // % — benchmark conventional 30yr rate for comparison
};

// ─── Formatters ──────────────────────────────────────────────────────────────
function fmt(n, prefix = "$", decimals = 0) {
  if (n === null || n === undefined || isNaN(n)) return "N/A";
  return prefix + Number(n).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtPct(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return "N/A";
  return Number(n).toFixed(decimals) + "%";
}
function n(v) { return Number(v || 0); }
function calcMonthlyPayment(principal, annualRate, years) {
  const r = annualRate / 100 / 12;
  const nm = years * 12;
  if (r === 0) return principal / nm;
  return principal * (r * Math.pow(1 + r, nm)) / (Math.pow(1 + r, nm) - 1);
}

// ─── Recalc ───────────────────────────────────────────────────────────────────
function recalcFinancials(r, expOvr, loan) {
  if (!r) return null;
  const orig = r.financials || {};
  const purchasePrice = n(orig.purchasePrice);
  const monthlyRent = n(orig.monthlyRent || r.rental?.estimatedMonthlyRent);
  const downAmt = purchasePrice * (loan.downPct / 100);
  const loanAmt = purchasePrice - downAmt;
  const mortgage = calcMonthlyPayment(loanAmt, loan.rate, loan.termYears);
  const origExp = orig.monthlyExpenses || {};
  const exp = {
    taxes:       expOvr.taxes       ?? n(origExp.taxes),
    insurance:   expOvr.insurance   ?? n(origExp.insurance),
    maintenance: expOvr.maintenance ?? n(origExp.maintenance),
    management:  expOvr.management  ?? n(origExp.management),
    vacancy:     expOvr.vacancy     ?? n(origExp.vacancy),
    capex:       expOvr.capex       ?? n(origExp.capex),
    hoa:         expOvr.hoa         ?? n(origExp.hoa),
  };
  exp.total = Object.values(exp).reduce((a, b) => a + b, 0);
  const monthlyNOI = monthlyRent - exp.total;
  const annualNOI = monthlyNOI * 12;
  const monthlyCF = monthlyNOI - mortgage;
  const annualCF = monthlyCF * 12;
  const capRate = purchasePrice > 0 ? (annualNOI / purchasePrice) * 100 : 0;
  const cashOnCash = downAmt > 0 ? (annualCF / downAmt) * 100 : 0;
  const grm = monthlyRent > 0 ? purchasePrice / (monthlyRent * 12) : 0;
  const dscr = mortgage > 0 ? monthlyNOI / mortgage : 0;
  const breakEven = monthlyRent > 0 ? ((mortgage + exp.total) / monthlyRent) * 100 : 0;
  return { purchasePrice, downPayment: downAmt, loanAmount: loanAmt, monthlyMortgage: mortgage, monthlyRent, monthlyExpenses: exp, monthlyNOI, annualNOI, monthlyCashFlow: monthlyCF, annualCashFlow: annualCF, capRate, cashOnCash, grm, dscr, breakEvenOccupancy: breakEven };
}

function evaluateCriteria(fin, rental, market, criteria) {
  if (!fin) return [];
  return [
    { label: "Monthly Cash Flow", value: fmt(fin.monthlyCashFlow), pass: fin.monthlyCashFlow >= criteria.minMonthlyCashFlow, threshold: `≥ ${fmt(criteria.minMonthlyCashFlow)}` },
    { label: "Cap Rate",          value: fmtPct(fin.capRate),       pass: fin.capRate >= criteria.minCapRate,                   threshold: `≥ ${criteria.minCapRate}%` },
    { label: "Cash-on-Cash",      value: fmtPct(fin.cashOnCash),    pass: fin.cashOnCash >= criteria.minCashOnCash,             threshold: `≥ ${criteria.minCashOnCash}%` },
    { label: "DSCR",              value: fin.dscr?.toFixed(2),       pass: fin.dscr >= criteria.minDSCR,                        threshold: `≥ ${criteria.minDSCR}` },
    { label: "GRM",               value: fin.grm?.toFixed(1),        pass: fin.grm <= criteria.maxGRM,                          threshold: `≤ ${criteria.maxGRM}` },
    { label: "Break-Even Occ.",   value: fmtPct(fin.breakEvenOccupancy), pass: fin.breakEvenOccupancy <= criteria.maxBreakEven, threshold: `≤ ${criteria.maxBreakEven}%` },
    { label: "1yr Appreciation",  value: fmtPct(market?.appreciation1yr), pass: (market?.appreciation1yr ?? 0) >= criteria.minAppreciation1yr, threshold: `≥ ${criteria.minAppreciation1yr}%` },
    { label: "Vacancy Rate",      value: fmtPct(rental?.vacancyRate), pass: (rental?.vacancyRate ?? 0) <= criteria.maxVacancyRate, threshold: `≤ ${criteria.maxVacancyRate}%` },
  ];
}

// ─── Max Purchase Price Solver ──────────────────────────────────────────────
// For each price-dependent criterion, find the highest purchase price at which
// the test still passes. Bisects over recalcFinancials using a synthetic price.
// Rent, expenses, down %, rate, and term are held constant.
function recalcAtPrice(r, expOvr, loan, price) {
  if (!r) return null;
  const cloned = { ...r, financials: { ...(r.financials || {}), purchasePrice: price } };
  return recalcFinancials(cloned, expOvr, loan);
}
function solveMaxPrice(testFn, r, expOvr, loan, opts = {}) {
  if (!r) return null;
  const { minPrice = 1000, maxPrice = 10000000, iterations = 32 } = opts;
  const finLo = recalcAtPrice(r, expOvr, loan, minPrice);
  if (!testFn(finLo)) return null;
  const finHi = recalcAtPrice(r, expOvr, loan, maxPrice);
  if (testFn(finHi)) return maxPrice;
  let lo = minPrice, hi = maxPrice;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (testFn(recalcAtPrice(r, expOvr, loan, mid))) lo = mid; else hi = mid;
  }
  return Math.floor(lo);
}

// ─── DSCR Loan Qualification Engine ──────────────────────────────────────────
// Lenders use: DSCR = Gross Rent ÷ PITIA (not NOI/debt service)
// PITIA = Principal & Interest + Taxes + Insurance + HOA (operating expenses excluded)
function buildDSCRQualification(fin, r, dc) {
  if (!fin || !r) return null;

  const rent      = fin.monthlyRent;
  const pi        = fin.monthlyMortgage;
  const taxes     = fin.monthlyExpenses.taxes;
  const insurance = fin.monthlyExpenses.insurance;
  const hoa       = fin.monthlyExpenses.hoa;
  const pitia     = pi + taxes + insurance + hoa;
  const lenderDscr = pitia > 0 ? rent / pitia : 0;

  const propValue  = r.valuation?.estimatedValue || fin.purchasePrice;
  const loanAmt    = fin.loanAmount;
  const ltv        = propValue > 0 ? (loanAmt / propValue) * 100 : 0;
  const reservesNeeded = pitia * dc.reservesMonths;

  const conv = dc.conventionalRate;

  const tiers = [
    {
      id: "A",
      label: "Tier A — Premium",
      desc: "Best pricing · most lenders · lowest rate premium",
      minDscr: dc.tier1MinDscr,
      maxLtv: dc.tier1MaxLtv,
      rateEst: `${(conv + dc.ratePremiumTier1).toFixed(2)}–${(conv + dc.ratePremiumTier1 + 0.375).toFixed(2)}%`,
      lenders: "Griffin Funding, Kiavi, Lima One, CoreVest, most regional DSCR lenders",
      color: "#00ff88",
    },
    {
      id: "B",
      label: "Tier B — Standard",
      desc: "Standard approval · widely available · moderate rate",
      minDscr: dc.tier2MinDscr,
      maxLtv: dc.tier2MaxLtv,
      rateEst: `${(conv + dc.ratePremiumTier2).toFixed(2)}–${(conv + dc.ratePremiumTier2 + 0.375).toFixed(2)}%`,
      lenders: "Visio Lending, Angel Oak, Deephaven, Velocity, Temple View",
      color: "#ffcc00",
    },
    {
      id: "C",
      label: "Tier C — No-Ratio",
      desc: "Limited lenders · high rate premium · lower LTV cap",
      minDscr: dc.tier3MinDscr,
      maxLtv: dc.tier3MaxLtv,
      rateEst: `${(conv + dc.ratePremiumTier3).toFixed(2)}–${(conv + dc.ratePremiumTier3 + 0.5).toFixed(2)}%`,
      lenders: "Civic Financial, Easy Street Capital, select portfolio lenders",
      color: "#ff8844",
    },
  ];

  const tiersWithChecks = tiers.map(t => {
    const checks = [
      { label: "Lender DSCR",     value: lenderDscr.toFixed(2) + "x", pass: lenderDscr >= t.minDscr,    need: `≥ ${t.minDscr}x`,     detail: `Gross Rent ${fmt(rent)} ÷ PITIA ${fmt(pitia)}` },
      { label: "Max LTV",         value: ltv.toFixed(1) + "%",         pass: ltv <= t.maxLtv,            need: `≤ ${t.maxLtv}%`,      detail: `Loan ${fmt(loanAmt)} ÷ Value ${fmt(propValue)}` },
      { label: "Min Prop. Value", value: fmt(propValue),               pass: propValue >= dc.minPropertyValue, need: `≥ ${fmt(dc.minPropertyValue)}`, detail: "AVM / purchase price" },
      { label: "Min Loan Amt",    value: fmt(loanAmt),                 pass: loanAmt >= dc.minLoanAmount, need: `≥ ${fmt(dc.minLoanAmount)}`, detail: "Most DSCR lenders" },
    ];
    const allPass = checks.every(c => c.pass);
    return { ...t, checks, qualified: allPass };
  });

  const highestTier = tiersWithChecks.find(t => t.qualified) || null;

  // Universal checks (not tier-specific)
  const universalChecks = [
    { label: "Rent Covers PITIA",   value: `${fmt(rent)} vs ${fmt(pitia)}`, pass: rent >= pitia,          detail: "Gross rent ≥ full PITIA payment" },
    { label: "Positive Cash Flow",  value: fmt(fin.monthlyCashFlow),       pass: fin.monthlyCashFlow > 0, detail: "After all expenses + mortgage" },
    { label: "Investment DSCR",     value: fin.dscr?.toFixed(2) + "x",    pass: fin.dscr >= 1.0,         detail: "NOI ÷ Debt Service (your metric)" },
    { label: "Lender DSCR (PITIA)", value: lenderDscr.toFixed(2) + "x",   pass: lenderDscr >= 1.0,       detail: "Gross Rent ÷ PITIA (lender metric)" },
    { label: "Reserves Required",   value: fmt(reservesNeeded),            pass: true,                    detail: `${dc.reservesMonths} mo × ${fmt(pitia)} PITIA — must be liquid at closing` },
  ];

  return { lenderDscr, pitia, rent, ltv, propValue, loanAmt, reservesNeeded, tiers: tiersWithChecks, highestTier, universalChecks, dc, pi, taxes, insurance, hoa };
}

// ─── Derivation Builder ───────────────────────────────────────────────────────
// Returns a map of label → { formula, calc, result, inputs[], explanation, source }
function buildDerivations(r, fin, loan) {
  if (!r || !fin) return {};
  const f = fin;
  const exp = f.monthlyExpenses;
  const expPct = f.monthlyRent > 0 ? ((exp.total / f.monthlyRent) * 100).toFixed(1) : "—";

  return {
    // ── Valuation ────────────────────────────────────────────────────────────
    "AVM Value": {
      label: "Automated Valuation Model (AVM)",
      explanation: "An AVM is a computer-generated estimate of market value using comparable sales, tax records, property characteristics, and local market trends. It is not a formal appraisal.",
      formula: "f(Comps, Tax Records, Property Data, Market Trends)",
      calc: `Model inputs: ${r.property?.beds}bd/${r.property?.baths}ba, ${r.property?.sqft?.toLocaleString()} sqft, built ${r.property?.yearBuilt}, ${r.property?.city} ${r.property?.state}`,
      result: fmt(r.valuation?.estimatedValue),
      inputs: [
        { label: "Property Size", value: `${r.property?.sqft?.toLocaleString()} sqft`, source: "Public Records" },
        { label: "Year Built", value: r.property?.yearBuilt, source: "Public Records" },
        { label: "Beds / Baths", value: `${r.property?.beds} / ${r.property?.baths}`, source: "MLS / Zillow" },
        { label: "Last Sale Price", value: fmt(r.valuation?.lastSalePrice), source: "County Deed Records" },
        { label: "Last Sale Date", value: r.valuation?.lastSaleDate || "N/A", source: "County Deed Records" },
      ],
      source: "Zillow Zestimate / Redfin Estimate / County AVM",
    },

    "Price/SqFt": {
      label: "Price per Square Foot",
      explanation: "Measures cost efficiency relative to similar properties. Lower is generally better but must be compared to local comps — cheap markets have lower $/sqft than expensive ones.",
      formula: "AVM Value ÷ Square Footage",
      calc: `${fmt(r.valuation?.estimatedValue)} ÷ ${r.property?.sqft?.toLocaleString()} sqft = ${fmt(r.valuation?.pricePerSqft)} / sqft`,
      result: fmt(r.valuation?.pricePerSqft),
      inputs: [
        { label: "AVM Value", value: fmt(r.valuation?.estimatedValue), source: "Zillow / Redfin" },
        { label: "Square Footage", value: `${r.property?.sqft?.toLocaleString()} sqft`, source: "Public Records" },
      ],
      source: "Calculated from AVM ÷ sqft",
    },

    "Last Sale": {
      label: "Last Recorded Sale Price",
      explanation: "The most recent arm's-length transaction price recorded in public deed records. Comparing to current AVM shows how much the property has appreciated (or depreciated) since purchase.",
      formula: "Public deed record — no calculation",
      calc: `Last sale: ${fmt(r.valuation?.lastSalePrice)} on ${r.valuation?.lastSaleDate || "unknown date"}. Current AVM: ${fmt(r.valuation?.estimatedValue)}. Implied change: ${r.valuation?.estimatedValue && r.valuation?.lastSalePrice ? fmt(r.valuation.estimatedValue - r.valuation.lastSalePrice) : "N/A"}`,
      result: fmt(r.valuation?.lastSalePrice),
      inputs: [
        { label: "Sale Price", value: fmt(r.valuation?.lastSalePrice), source: "County Deed Records" },
        { label: "Sale Date", value: r.valuation?.lastSaleDate || "N/A", source: "County Deed Records" },
        { label: "Current AVM", value: fmt(r.valuation?.estimatedValue), source: "Zillow / Redfin" },
      ],
      source: "County Deed / Tax Assessor Records",
    },

    // ── Rental Market ─────────────────────────────────────────────────────────
    "Est. Rent": {
      label: "Estimated Market Rent",
      explanation: "The estimated monthly rent you could achieve based on comparable rentals in the immediate area. This is the most critical input in the entire financial model — small changes here cascade into every metric.",
      formula: "Median of rental comps within 0.5–1 mile radius, adjusted for property characteristics",
      calc: `Market rent range: ${fmt(r.rental?.rentRange?.low)} – ${fmt(r.rental?.rentRange?.high)} / mo. Midpoint estimate: ${fmt(r.rental?.estimatedMonthlyRent)} / mo. Rent per sqft: ${fmt(r.rental?.rentPerSqft, "$", 2)} / sqft`,
      result: fmt(r.rental?.estimatedMonthlyRent),
      inputs: [
        { label: "Rent Range (Low)", value: fmt(r.rental?.rentRange?.low), source: "Rentometer / Zillow Rent" },
        { label: "Rent Range (High)", value: fmt(r.rental?.rentRange?.high), source: "Rentometer / Zillow Rent" },
        { label: "Property Sqft", value: `${r.property?.sqft?.toLocaleString()} sqft`, source: "Public Records" },
        { label: "Beds / Baths", value: `${r.property?.beds}bd / ${r.property?.baths}ba`, source: "MLS / Zillow" },
        { label: "Avg Days to Rent", value: `${r.rental?.averageDaysToRent || "N/A"} days`, source: "Rentometer / Local MLS" },
      ],
      source: "Rentometer, Zillow Rent Zestimate, Zumper, local MLS comps",
    },

    "Monthly Rent": {
      label: "Gross Monthly Rent",
      explanation: "The gross monthly rent used in all financial calculations. This is the AI-estimated market rent pulled from rental data sources.",
      formula: "Market Rent Estimate (from comps)",
      calc: `Estimated market rent: ${fmt(f.monthlyRent)} / mo (${fmt(r.rental?.rentRange?.low)} – ${fmt(r.rental?.rentRange?.high)} range). Annual gross: ${fmt(f.monthlyRent * 12)}`,
      result: fmt(f.monthlyRent),
      inputs: [
        { label: "Rental Comp Range", value: `${fmt(r.rental?.rentRange?.low)} – ${fmt(r.rental?.rentRange?.high)}`, source: "Rentometer / Zillow" },
        { label: "Avg Days to Rent", value: `${r.rental?.averageDaysToRent || "N/A"} days`, source: "Local MLS" },
        { label: "Vacancy Rate (Market)", value: fmtPct(r.rental?.vacancyRate), source: "Market Data" },
      ],
      source: "Rentometer, Zillow Rent Zestimate, Zumper",
    },

    "Rent/SqFt": {
      label: "Rent per Square Foot",
      explanation: "Useful for comparing rental efficiency across different-sized properties and markets. Higher rent/sqft relative to comps suggests premium location or condition.",
      formula: "Monthly Rent ÷ Square Footage",
      calc: `${fmt(f.monthlyRent)} ÷ ${r.property?.sqft?.toLocaleString()} sqft = ${fmt(r.rental?.rentPerSqft, "$", 2)} / sqft`,
      result: fmt(r.rental?.rentPerSqft, "$", 2),
      inputs: [
        { label: "Monthly Rent", value: fmt(f.monthlyRent), source: "Rentometer / Zillow" },
        { label: "Square Footage", value: `${r.property?.sqft?.toLocaleString()} sqft`, source: "Public Records" },
      ],
      source: "Calculated from market rent ÷ sqft",
    },

    "Vacancy Rate": {
      label: "Market Vacancy Rate",
      explanation: "The percentage of rental units in the local market that are currently unoccupied. A lower rate means strong rental demand and less downtime between tenants. Used to estimate your effective rent.",
      formula: "Local market vacancy statistic (not a calculation)",
      calc: `Market vacancy: ${fmtPct(r.rental?.vacancyRate)}. Effective annual rent (accounting for vacancy): ${fmt(f.monthlyRent * 12 * (1 - n(r.rental?.vacancyRate) / 100))} (vs gross ${fmt(f.monthlyRent * 12)})`,
      result: fmtPct(r.rental?.vacancyRate),
      inputs: [
        { label: "Market Vacancy", value: fmtPct(r.rental?.vacancyRate), source: "HUD / Local MLS Data" },
        { label: "Avg Days to Rent", value: `${r.rental?.averageDaysToRent || "N/A"} days`, source: "Local MLS" },
        { label: "Monthly Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
      ],
      source: "HUD Rental Market Survey, Local MLS vacancy data",
    },

    "Rent Range": {
      label: "Rental Comparable Range",
      explanation: "The low-to-high range of rents for comparable properties (similar beds/baths/sqft) within approximately 0.5–1 mile. The estimated rent should fall within this band.",
      formula: "Min and Max of rental comps — no calculation",
      calc: `Low comp: ${fmt(r.rental?.rentRange?.low)} / mo | High comp: ${fmt(r.rental?.rentRange?.high)} / mo | Spread: ${fmt((r.rental?.rentRange?.high || 0) - (r.rental?.rentRange?.low || 0))} | Estimated rent (${fmt(f.monthlyRent)}) is ${f.monthlyRent > 0 && r.rental?.rentRange?.high > 0 ? (((f.monthlyRent - r.rental.rentRange.low) / (r.rental.rentRange.high - r.rental.rentRange.low) * 100) || 0).toFixed(0) + "% through the range" : "within range"}`,
      result: `${fmt(r.rental?.rentRange?.low)} – ${fmt(r.rental?.rentRange?.high)}`,
      inputs: [
        { label: "Low Comp", value: fmt(r.rental?.rentRange?.low), source: "Rentometer / Zillow" },
        { label: "High Comp", value: fmt(r.rental?.rentRange?.high), source: "Rentometer / Zillow" },
        { label: "Beds / Baths Match", value: `${r.property?.beds}bd / ${r.property?.baths}ba`, source: "Property Data" },
      ],
      source: "Rentometer, Zillow Rental Listings, Zumper",
    },

    "Days to Rent": {
      label: "Average Days to Rent",
      explanation: "The average number of days a comparable rental property sits on the market before being leased. Lower is better — it signals strong demand and helps minimize vacancy losses.",
      formula: "Market statistic — no calculation",
      calc: `Avg days to rent: ${r.rental?.averageDaysToRent || "N/A"} days. At this rate, annual vacancy loss ≈ ${fmt(f.monthlyRent / 30 * n(r.rental?.averageDaysToRent))} per turn if tenant turns over annually.`,
      result: `${r.rental?.averageDaysToRent || "N/A"} days`,
      inputs: [
        { label: "Days on Market (Rental)", value: `${r.rental?.averageDaysToRent || "N/A"} days`, source: "Local MLS" },
        { label: "Market Vacancy Rate", value: fmtPct(r.rental?.vacancyRate), source: "HUD Data" },
      ],
      source: "Local MLS / Rentometer market stats",
    },

    // ── Key Financial Metrics ─────────────────────────────────────────────────
    "Cash Flow/mo": {
      label: "Monthly Cash Flow",
      explanation: "The money left over each month after paying ALL expenses AND the mortgage. This is your actual take-home profit. Positive cash flow is the first test of a good rental investment.",
      formula: "Monthly NOI − Monthly Mortgage Payment",
      calc: `Monthly NOI (${fmt(f.monthlyNOI)}) − Mortgage P&I (${fmt(f.monthlyMortgage)}) = ${fmt(f.monthlyCashFlow)} / mo`,
      result: fmt(f.monthlyCashFlow),
      inputs: [
        { label: "Gross Monthly Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
        { label: "Total Monthly Expenses", value: fmt(exp.total), source: "Calculated" },
        { label: "Monthly NOI", value: fmt(f.monthlyNOI), source: "Calculated" },
        { label: `Mortgage (${loan.downPct}% dn, ${loan.rate}%, ${loan.termYears}yr)`, value: fmt(f.monthlyMortgage), source: "Loan Calculator" },
      ],
      source: "Calculated from market rent, expenses, and loan terms",
    },

    "Cap Rate": {
      label: "Capitalization Rate",
      explanation: "Cap rate measures the annual return on a property as if you paid cash — no financing. It lets you compare investments regardless of how they're financed. Think of it as the property's inherent yield.",
      formula: "(Annual NOI ÷ Purchase Price) × 100",
      calc: `Annual NOI: ${fmt(f.monthlyNOI)} × 12 = ${fmt(f.annualNOI)}\n(${fmt(f.annualNOI)} ÷ ${fmt(f.purchasePrice)}) × 100 = ${fmtPct(f.capRate)}`,
      result: fmtPct(f.capRate),
      inputs: [
        { label: "Monthly Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
        { label: "Total Monthly Expenses", value: fmt(exp.total), source: "Calculated" },
        { label: "Monthly NOI", value: fmt(f.monthlyNOI), source: "Calculated" },
        { label: "Annual NOI", value: fmt(f.annualNOI), source: "Monthly NOI × 12" },
        { label: "Purchase Price", value: fmt(f.purchasePrice), source: "Listing / AVM" },
      ],
      source: "Calculated: Annual NOI ÷ Purchase Price",
    },

    "Cash-on-Cash": {
      label: "Cash-on-Cash Return",
      explanation: "The actual cash yield on your invested equity. Unlike cap rate, this accounts for your specific financing. It answers: 'What percent return am I earning on the dollars I actually put in?'",
      formula: "(Annual Cash Flow ÷ Total Cash Invested) × 100",
      calc: `Down payment (${loan.downPct}%): ${fmt(f.downPayment)}\nAnnual cash flow: ${fmt(f.monthlyCashFlow)} × 12 = ${fmt(f.annualCashFlow)}\n(${fmt(f.annualCashFlow)} ÷ ${fmt(f.downPayment)}) × 100 = ${fmtPct(f.cashOnCash)}`,
      result: fmtPct(f.cashOnCash),
      inputs: [
        { label: "Purchase Price", value: fmt(f.purchasePrice), source: "Listing" },
        { label: `Down Payment (${loan.downPct}%)`, value: fmt(f.downPayment), source: "Loan Settings" },
        { label: "Monthly Cash Flow", value: fmt(f.monthlyCashFlow), source: "Calculated" },
        { label: "Annual Cash Flow", value: fmt(f.annualCashFlow), source: "Monthly × 12" },
      ],
      source: "Calculated: Annual Cash Flow ÷ Down Payment",
    },

    "DSCR": {
      label: "Debt Service Coverage Ratio",
      explanation: "DSCR measures how well the property's income covers its debt payments. A DSCR of 1.25 means the property earns 25% more than needed to pay the mortgage — the standard lender minimum. Below 1.0 means the rent doesn't cover the loan.",
      formula: "Monthly NOI ÷ Monthly Mortgage Payment",
      calc: `Monthly NOI (${fmt(f.monthlyNOI)}) ÷ Monthly Mortgage (${fmt(f.monthlyMortgage)}) = ${f.dscr?.toFixed(2)}x\n${f.dscr >= 1.25 ? "✓ Meets lender standard (≥ 1.25)" : f.dscr >= 1.0 ? "⚠ Covers debt but below lender standard" : "✗ NOI does not cover debt service"}`,
      result: `${f.dscr?.toFixed(2)}x`,
      inputs: [
        { label: "Monthly Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
        { label: "Total Monthly Expenses", value: fmt(exp.total), source: "Calculated" },
        { label: "Monthly NOI", value: fmt(f.monthlyNOI), source: "Rent − Expenses" },
        { label: "Monthly Mortgage", value: fmt(f.monthlyMortgage), source: `${loan.rate}% / ${loan.termYears}yr on ${fmt(f.loanAmount)}` },
      ],
      source: "Calculated: Monthly NOI ÷ Monthly Debt Service",
    },

    "GRM": {
      label: "Gross Rent Multiplier",
      explanation: "GRM is a quick sanity-check ratio: how many years of gross rent equals the purchase price. Lower is better. A GRM of 10 means you'd recoup the price in 10 years of rent (before expenses). Most residential SFR investors target GRM < 15.",
      formula: "Purchase Price ÷ Annual Gross Rent",
      calc: `Annual rent: ${fmt(f.monthlyRent)} × 12 = ${fmt(f.monthlyRent * 12)}\n${fmt(f.purchasePrice)} ÷ ${fmt(f.monthlyRent * 12)} = ${f.grm?.toFixed(1)}x`,
      result: `${f.grm?.toFixed(1)}x`,
      inputs: [
        { label: "Purchase Price", value: fmt(f.purchasePrice), source: "Listing / AVM" },
        { label: "Monthly Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
        { label: "Annual Gross Rent", value: fmt(f.monthlyRent * 12), source: "Monthly × 12" },
      ],
      source: "Calculated: Purchase Price ÷ Annual Rent",
    },

    "Break-Even": {
      label: "Break-Even Occupancy Rate",
      explanation: "The minimum occupancy percentage needed to cover ALL costs (expenses + mortgage). If break-even is 80%, the property needs to be occupied at least 80% of the time to avoid losing money. Lower is safer.",
      formula: "(Monthly Mortgage + Monthly Expenses) ÷ Monthly Rent × 100",
      calc: `Fixed costs: ${fmt(f.monthlyMortgage)} + ${fmt(exp.total)} = ${fmt(f.monthlyMortgage + exp.total)}\n(${fmt(f.monthlyMortgage + exp.total)} ÷ ${fmt(f.monthlyRent)}) × 100 = ${fmtPct(f.breakEvenOccupancy)}\nThis means ${(100 - f.breakEvenOccupancy).toFixed(1)}% vacancy cushion before going negative.`,
      result: fmtPct(f.breakEvenOccupancy),
      inputs: [
        { label: "Monthly Mortgage", value: fmt(f.monthlyMortgage), source: "Loan Calculator" },
        { label: "Total Monthly Expenses", value: fmt(exp.total), source: "Calculated" },
        { label: "Total Fixed Monthly Costs", value: fmt(f.monthlyMortgage + exp.total), source: "Mortgage + Expenses" },
        { label: "Monthly Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
      ],
      source: "Calculated: (Mortgage + Expenses) ÷ Rent",
    },

    // ── Deal Structure ────────────────────────────────────────────────────────
    "Purchase Price": {
      label: "Purchase / List Price",
      explanation: "The assumed acquisition price used for all financial calculations. This is sourced from the listing or AVM estimate.",
      formula: "Direct input from listing data",
      calc: `Purchase price: ${fmt(f.purchasePrice)} | AVM estimate: ${fmt(r.valuation?.estimatedValue)} | Difference: ${fmt(f.purchasePrice - n(r.valuation?.estimatedValue))} (${r.valuation?.estimatedValue ? ((f.purchasePrice / r.valuation.estimatedValue - 1) * 100).toFixed(1) + "% vs AVM" : "N/A"})`,
      result: fmt(f.purchasePrice),
      inputs: [
        { label: "List / Acquisition Price", value: fmt(f.purchasePrice), source: "Zillow / MLS Listing" },
        { label: "AVM Estimate", value: fmt(r.valuation?.estimatedValue), source: "Zillow Zestimate" },
      ],
      source: "Zillow / MLS listing price",
    },

    [`Down (${loan.downPct}%)`]: {
      label: `Down Payment (${loan.downPct}%)`,
      explanation: "The cash you put in at closing. This is your total equity at purchase and the denominator for Cash-on-Cash return. A larger down payment lowers the mortgage but reduces CoC yield.",
      formula: "Purchase Price × Down Payment %",
      calc: `${fmt(f.purchasePrice)} × ${loan.downPct}% = ${fmt(f.downPayment)}`,
      result: fmt(f.downPayment),
      inputs: [
        { label: "Purchase Price", value: fmt(f.purchasePrice), source: "Listing" },
        { label: "Down Payment %", value: `${loan.downPct}%`, source: "Loan Settings" },
      ],
      source: "Loan Settings → Calculated",
    },

    "Loan Amount": {
      label: "Loan Principal",
      explanation: "The amount financed. This determines your monthly mortgage payment and total interest paid over the life of the loan.",
      formula: "Purchase Price − Down Payment",
      calc: `${fmt(f.purchasePrice)} − ${fmt(f.downPayment)} = ${fmt(f.loanAmount)}`,
      result: fmt(f.loanAmount),
      inputs: [
        { label: "Purchase Price", value: fmt(f.purchasePrice), source: "Listing" },
        { label: "Down Payment", value: fmt(f.downPayment), source: "Calculated" },
      ],
      source: "Calculated: Purchase Price − Down Payment",
    },

    [`Monthly P&I (${loan.rate}% / ${loan.termYears}yr)`]: {
      label: "Monthly Principal & Interest Payment",
      explanation: "The fixed monthly mortgage payment calculated using a standard amortization formula. This does NOT include taxes or insurance (PITI) — those are separate expense line items.",
      formula: "P × [r(1+r)^n] ÷ [(1+r)^n − 1]",
      calc: `Principal (P): ${fmt(f.loanAmount)}\nMonthly rate (r): ${loan.rate}% ÷ 12 = ${(loan.rate / 12).toFixed(4)}%\nPayments (n): ${loan.termYears} × 12 = ${loan.termYears * 12}\nPayment = ${fmt(f.loanAmount)} × [${(loan.rate / 100 / 12).toFixed(6)}(1+${(loan.rate / 100 / 12).toFixed(6)})^${loan.termYears * 12}] ÷ [(1+${(loan.rate / 100 / 12).toFixed(6)})^${loan.termYears * 12} − 1] = ${fmt(f.monthlyMortgage)}`,
      result: fmt(f.monthlyMortgage),
      inputs: [
        { label: "Loan Amount", value: fmt(f.loanAmount), source: "Calculated" },
        { label: "Interest Rate", value: `${loan.rate}% annually`, source: "Loan Settings" },
        { label: "Loan Term", value: `${loan.termYears} years (${loan.termYears * 12} payments)`, source: "Loan Settings" },
        { label: "Monthly Rate", value: `${(loan.rate / 12).toFixed(4)}%`, source: "Annual Rate ÷ 12" },
      ],
      source: "Standard amortization formula from loan settings",
    },

    "Gross Monthly Rent": {
      label: "Gross Monthly Rent",
      explanation: "The top-line rental income before any expenses are deducted.",
      formula: "Market rent estimate",
      calc: `Gross rent: ${fmt(f.monthlyRent)} / mo | Annual: ${fmt(f.monthlyRent * 12)} / yr`,
      result: fmt(f.monthlyRent),
      inputs: [{ label: "Market Rent Estimate", value: fmt(f.monthlyRent), source: "Rentometer / Zillow" }],
      source: "Rental market comps",
    },

    "Annual NOI": {
      label: "Annual Net Operating Income",
      explanation: "NOI is the annual income after ALL operating expenses but BEFORE mortgage payments. It's the most important income measure for property valuation — cap rate and most lending ratios are based on NOI.",
      formula: "(Monthly Rent − Monthly Operating Expenses) × 12",
      calc: `Monthly NOI: ${fmt(f.monthlyRent)} − ${fmt(exp.total)} = ${fmt(f.monthlyNOI)}\nAnnual NOI: ${fmt(f.monthlyNOI)} × 12 = ${fmt(f.annualNOI)}\nExpense ratio: ${expPct}% of gross rent`,
      result: fmt(f.annualNOI),
      inputs: [
        { label: "Monthly Gross Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
        { label: "Monthly Operating Expenses", value: fmt(exp.total), source: "Calculated" },
        { label: "Monthly NOI", value: fmt(f.monthlyNOI), source: "Rent − Expenses" },
        { label: "Expense Ratio", value: `${expPct}%`, source: "Calculated" },
      ],
      source: "Calculated: (Rent − Expenses) × 12",
    },

    "Annual Cash Flow": {
      label: "Annual Cash Flow",
      explanation: "The total cash profit (or loss) generated per year after ALL costs including the mortgage. This is what you actually pocket as the investor.",
      formula: "Monthly Cash Flow × 12",
      calc: `Monthly cash flow: ${fmt(f.monthlyCashFlow)}\nAnnual: ${fmt(f.monthlyCashFlow)} × 12 = ${fmt(f.annualCashFlow)}\nReturn on equity: ${fmtPct(f.cashOnCash)} (annual cash flow ÷ down payment)`,
      result: fmt(f.annualCashFlow),
      inputs: [
        { label: "Monthly Cash Flow", value: fmt(f.monthlyCashFlow), source: "Calculated" },
        { label: "Annual NOI", value: fmt(f.annualNOI), source: "Calculated" },
        { label: "Annual Mortgage Cost", value: fmt(f.monthlyMortgage * 12), source: "Monthly × 12" },
      ],
      source: "Calculated: Monthly Cash Flow × 12",
    },

    // ── Expenses ──────────────────────────────────────────────────────────────
    "Property Taxes": {
      label: "Monthly Property Tax",
      explanation: "Annual property tax divided by 12. Tax amounts are pulled from county assessor records or estimated from the effective tax rate for the county. This is one of the largest and most predictable expenses.",
      formula: "Annual Property Tax ÷ 12",
      calc: `Monthly tax: ${fmt(exp.taxes)} | Annual: ${fmt(exp.taxes * 12)} | Effective rate vs value: ${r.valuation?.estimatedValue ? ((exp.taxes * 12 / r.valuation.estimatedValue) * 100).toFixed(2) + "%" : "N/A"}`,
      result: fmt(exp.taxes),
      inputs: [
        { label: "Annual Property Tax", value: fmt(exp.taxes * 12), source: "County Assessor / Tax Records" },
        { label: "Assessed Value", value: fmt(r.valuation?.estimatedValue), source: "County Assessor" },
        { label: "Effective Tax Rate", value: r.valuation?.estimatedValue ? ((exp.taxes * 12 / r.valuation.estimatedValue) * 100).toFixed(2) + "%" : "N/A", source: "Calculated" },
      ],
      source: "County Tax Assessor Records / AI estimate",
    },

    "Insurance": {
      label: "Monthly Landlord Insurance",
      explanation: "Landlord insurance (dwelling fire policy) covers the structure and liability. It costs more than homeowner's insurance. Standard rule of thumb: $800–$1,500/yr for a typical SFR, or ~0.5–1% of value annually.",
      formula: "Annual Insurance Premium ÷ 12",
      calc: `Monthly insurance: ${fmt(exp.insurance)} | Annual: ${fmt(exp.insurance * 12)} | Rate vs value: ${r.valuation?.estimatedValue ? ((exp.insurance * 12 / r.valuation.estimatedValue) * 100).toFixed(2) + "% of AVM" : "N/A"}`,
      result: fmt(exp.insurance),
      inputs: [
        { label: "Annual Premium", value: fmt(exp.insurance * 12), source: "Market Rate Estimate" },
        { label: "Property Value", value: fmt(r.valuation?.estimatedValue), source: "AVM" },
        { label: "Coverage Type", value: "DP3 Landlord Policy", source: "Standard SFR Coverage" },
      ],
      source: "Market rate estimate / AI research",
    },

    "Maintenance": {
      label: "Monthly Maintenance Reserve",
      explanation: "An ongoing reserve for routine repairs and upkeep — landscaping, minor repairs, appliances, etc. Common rule of thumb: 1% of property value per year, or $50–$150/mo for a typical SFR.",
      formula: "~1% of property value annually ÷ 12 (or fixed estimate)",
      calc: `Monthly maintenance: ${fmt(exp.maintenance)} | Annual: ${fmt(exp.maintenance * 12)} | As % of value: ${r.valuation?.estimatedValue ? ((exp.maintenance * 12 / r.valuation.estimatedValue) * 100).toFixed(2) + "%" : "N/A"} | As % of rent: ${f.monthlyRent ? ((exp.maintenance / f.monthlyRent) * 100).toFixed(1) + "%" : "N/A"}`,
      result: fmt(exp.maintenance),
      inputs: [
        { label: "Property Age", value: r.property?.yearBuilt ? `Built ${r.property.yearBuilt} (${new Date().getFullYear() - r.property.yearBuilt} yrs old)` : "N/A", source: "Public Records" },
        { label: "Property Value", value: fmt(r.valuation?.estimatedValue), source: "AVM" },
        { label: "Rule of Thumb", value: "1% of value / yr", source: "Industry Standard" },
      ],
      source: "AI estimate based on property age, size, and value",
    },

    "Property Mgmt": {
      label: "Monthly Property Management Fee",
      explanation: "If you use a property manager, they typically charge 8–12% of monthly rent. This is calculated as a percentage of collected rent, so vacant months cost less — but you also collect nothing.",
      formula: "Monthly Rent × Management Rate (typically 8–10%)",
      calc: `Management fee: ${fmt(exp.management)} | As % of rent: ${f.monthlyRent ? ((exp.management / f.monthlyRent) * 100).toFixed(1) + "%" : "N/A"} | Annual cost: ${fmt(exp.management * 12)}`,
      result: fmt(exp.management),
      inputs: [
        { label: "Monthly Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
        { label: "Management Rate", value: f.monthlyRent ? ((exp.management / f.monthlyRent) * 100).toFixed(1) + "%" : "N/A", source: "Local Property Mgmt Market" },
        { label: "Annual Fee", value: fmt(exp.management * 12), source: "Calculated" },
      ],
      source: "Industry standard 8–10% of gross rent",
    },

    "Vacancy Reserve": {
      label: "Monthly Vacancy Reserve",
      explanation: "An expense reserve accounting for periods when the property is unoccupied (tenant turnover, rehab between tenants, etc.). Typically 5–8% of monthly rent. Even great properties average some vacancy over time.",
      formula: "Monthly Rent × Vacancy Rate (typically 5–8%)",
      calc: `Vacancy reserve: ${fmt(exp.vacancy)} | As % of rent: ${f.monthlyRent ? ((exp.vacancy / f.monthlyRent) * 100).toFixed(1) + "%" : "N/A"} | Implies ${(n(r.rental?.vacancyRate) || (exp.vacancy / f.monthlyRent * 100)).toFixed(1)} vacancy days/yr equiv.`,
      result: fmt(exp.vacancy),
      inputs: [
        { label: "Monthly Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
        { label: "Market Vacancy Rate", value: fmtPct(r.rental?.vacancyRate), source: "Market Data" },
        { label: "Avg Days to Rent", value: `${r.rental?.averageDaysToRent || "N/A"} days`, source: "MLS Data" },
      ],
      source: "5–8% of gross rent / local vacancy rate",
    },

    "CapEx Reserve": {
      label: "Monthly Capital Expenditure Reserve",
      explanation: "A reserve for major non-routine expenses: roof replacement, HVAC, water heater, flooring, etc. These can cost $5,000–$20,000 each. Setting aside 5–10% of rent monthly protects against large surprise costs.",
      formula: "Monthly Rent × CapEx Rate (typically 5–10%)",
      calc: `CapEx reserve: ${fmt(exp.capex)} | Annual: ${fmt(exp.capex * 12)} | As % of rent: ${f.monthlyRent ? ((exp.capex / f.monthlyRent) * 100).toFixed(1) + "%" : "N/A"} | Property age factor: ${r.property?.yearBuilt ? new Date().getFullYear() - r.property.yearBuilt + " years old" : "unknown"}`,
      result: fmt(exp.capex),
      inputs: [
        { label: "Monthly Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
        { label: "Year Built", value: r.property?.yearBuilt || "N/A", source: "Public Records" },
        { label: "Property Age", value: r.property?.yearBuilt ? `${new Date().getFullYear() - r.property.yearBuilt} years` : "N/A", source: "Calculated" },
        { label: "Standard Reserve", value: "5–10% of monthly rent", source: "Industry Standard" },
      ],
      source: "Industry standard reserve based on property age",
    },

    "HOA": {
      label: "HOA Monthly Dues",
      explanation: "Monthly Homeowners Association fees, if applicable. HOA dues are a hard fixed cost — they don't go away when the unit is vacant. Always verify directly with the HOA for the current amount and any pending special assessments.",
      formula: "Direct HOA amount — no calculation",
      calc: `Monthly HOA: ${fmt(exp.hoa)} | Annual: ${fmt(exp.hoa * 12)} | As % of rent: ${f.monthlyRent ? ((exp.hoa / f.monthlyRent) * 100).toFixed(1) + "%" : "N/A"}`,
      result: fmt(exp.hoa),
      inputs: [
        { label: "HOA Monthly Dues", value: fmt(exp.hoa), source: "HOA Records / Listing" },
        { label: "Annual HOA Cost", value: fmt(exp.hoa * 12), source: "Calculated" },
      ],
      source: "HOA Records / MLS Listing",
    },

    "TOTAL": {
      label: "Total Monthly Operating Expenses",
      explanation: "The sum of all operating expense line items. Does NOT include the mortgage — that's a financing cost, not an operating expense. The expense ratio (expenses ÷ rent) should typically be 35–50% for a well-run SFR.",
      formula: "Taxes + Insurance + Maintenance + Management + Vacancy + CapEx + HOA",
      calc: `${fmt(exp.taxes)} (tax) + ${fmt(exp.insurance)} (ins) + ${fmt(exp.maintenance)} (maint) + ${fmt(exp.management)} (mgmt) + ${fmt(exp.vacancy)} (vacancy) + ${fmt(exp.capex)} (capex) + ${fmt(exp.hoa)} (HOA) = ${fmt(exp.total)}\nExpense ratio: ${expPct}% of gross rent`,
      result: fmt(exp.total),
      inputs: [
        { label: "Property Taxes", value: fmt(exp.taxes), source: "County Records" },
        { label: "Insurance", value: fmt(exp.insurance), source: "Market Rate" },
        { label: "Maintenance", value: fmt(exp.maintenance), source: "1% Rule Estimate" },
        { label: "Property Mgmt", value: fmt(exp.management), source: "8–10% of Rent" },
        { label: "Vacancy Reserve", value: fmt(exp.vacancy), source: "5–8% of Rent" },
        { label: "CapEx Reserve", value: fmt(exp.capex), source: "5–10% of Rent" },
        { label: "HOA", value: fmt(exp.hoa), source: "HOA Records" },
        { label: "Expense Ratio", value: `${expPct}%`, source: "Total ÷ Gross Rent" },
      ],
      source: "Sum of all operating expense estimates",
    },

    // ── Market ────────────────────────────────────────────────────────────────
    "1yr Appreciation": {
      label: "1-Year Home Price Appreciation",
      explanation: "The percentage change in median home values in this market over the past 12 months. Appreciation is the second major return driver (alongside cash flow). Markets with strong appreciation can justify lower initial yields.",
      formula: "(Current Median Price − Prior Year Median Price) ÷ Prior Year Median Price × 100",
      calc: `1yr appreciation in ${r.property?.city}, ${r.property?.state}: ${fmtPct(r.market?.appreciation1yr)}\n3yr: ${fmtPct(r.market?.appreciation3yr)} | 5yr: ${fmtPct(r.market?.appreciation5yr)}\nImplied equity gain on ${fmt(f.purchasePrice)}: ${fmt(f.purchasePrice * n(r.market?.appreciation1yr) / 100)} in year 1`,
      result: fmtPct(r.market?.appreciation1yr),
      inputs: [
        { label: "Market", value: `${r.property?.city}, ${r.property?.state}`, source: "Property Address" },
        { label: "1yr Change", value: fmtPct(r.market?.appreciation1yr), source: "Zillow / Case-Shiller / FHFA" },
        { label: "3yr Change", value: fmtPct(r.market?.appreciation3yr), source: "Zillow Market Data" },
        { label: "5yr Change", value: fmtPct(r.market?.appreciation5yr), source: "Zillow Market Data" },
      ],
      source: "Zillow Market Reports / FHFA / Case-Shiller Index",
    },

    "3yr Appreciation": {
      label: "3-Year Home Price Appreciation",
      explanation: "Cumulative appreciation over 3 years. A longer time horizon smooths out short-term volatility and gives a better picture of the market's structural trajectory.",
      formula: "3-year cumulative price change in local market",
      calc: `3yr appreciation: ${fmtPct(r.market?.appreciation3yr)} | 1yr: ${fmtPct(r.market?.appreciation1yr)} | 5yr: ${fmtPct(r.market?.appreciation5yr)}`,
      result: fmtPct(r.market?.appreciation3yr),
      inputs: [
        { label: "3yr Change", value: fmtPct(r.market?.appreciation3yr), source: "Market Data" },
        { label: "Market", value: `${r.property?.city}, ${r.property?.state}`, source: "Property Location" },
      ],
      source: "Zillow Market Reports / FHFA HPI",
    },

    "5yr Appreciation": {
      label: "5-Year Home Price Appreciation",
      explanation: "The full 5-year appreciation trend. Most useful for assessing whether a market has long-term value creation or is stagnant/declining. Strong 5yr appreciation often forecasts continued demand.",
      formula: "5-year cumulative price change in local market",
      calc: `5yr appreciation: ${fmtPct(r.market?.appreciation5yr)} | Implies avg annual: ${((Math.pow(1 + n(r.market?.appreciation5yr) / 100, 1 / 5) - 1) * 100).toFixed(2)}% CAGR`,
      result: fmtPct(r.market?.appreciation5yr),
      inputs: [
        { label: "5yr Change", value: fmtPct(r.market?.appreciation5yr), source: "Market Data" },
        { label: "Annual CAGR", value: ((Math.pow(1 + n(r.market?.appreciation5yr) / 100, 1 / 5) - 1) * 100).toFixed(2) + "%", source: "Calculated" },
      ],
      source: "Zillow Market Reports / FHFA HPI",
    },

    "Rent Growth 1yr": {
      label: "1-Year Rent Growth",
      explanation: "How much rents have increased in this market over the past 12 months. Positive rent growth means your future income should increase, improving all returns over time.",
      formula: "(Current Median Rent − Prior Year Median Rent) ÷ Prior Year Median Rent × 100",
      calc: `1yr rent growth in ${r.property?.city}, ${r.property?.state}: ${fmtPct(r.market?.rentGrowth1yr)}\nIf rent grows ${fmtPct(r.market?.rentGrowth1yr)} annually, in 3yrs: ${fmt(f.monthlyRent * Math.pow(1 + n(r.market?.rentGrowth1yr) / 100, 3))} / mo`,
      result: fmtPct(r.market?.rentGrowth1yr),
      inputs: [
        { label: "Market", value: `${r.property?.city}, ${r.property?.state}`, source: "Property Address" },
        { label: "1yr Rent Change", value: fmtPct(r.market?.rentGrowth1yr), source: "Zillow / Apartment List / Zumper" },
        { label: "Current Est. Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
      ],
      source: "Zillow Rent Index / Apartment List / Zumper National Rent Report",
    },

    "Days on Market": {
      label: "Average Days on Market (Sales)",
      explanation: "How long homes are sitting before selling. A low DOM signals high buyer demand and a competitive market — good for appreciation. High DOM may indicate a softening market.",
      formula: "Market statistic — no calculation",
      calc: `Avg DOM: ${r.market?.daysOnMarket || "N/A"} days. Market trend: ${r.market?.marketTrend || "N/A"}. ${r.market?.daysOnMarket < 14 ? "Hot market — expect competition." : r.market?.daysOnMarket < 30 ? "Active market." : "Slower market — more negotiating room."}`,
      result: `${r.market?.daysOnMarket || "N/A"} days`,
      inputs: [
        { label: "Avg Days on Market", value: `${r.market?.daysOnMarket || "N/A"} days`, source: "Local MLS Data" },
        { label: "Market Trend", value: r.market?.marketTrend || "N/A", source: "Market Analysis" },
      ],
      source: "Local MLS market reports",
    },

    "Market Trend": {
      label: "Overall Market Trend Assessment",
      explanation: "A qualitative summary of whether the local market is appreciating, flat, or declining based on price trends, inventory, days on market, and demand indicators.",
      formula: "Qualitative assessment — no formula",
      calc: `Market: ${r.property?.city}, ${r.property?.state}\nTrend: ${r.market?.marketTrend || "N/A"}\n1yr appreciation: ${fmtPct(r.market?.appreciation1yr)} | Rent growth: ${fmtPct(r.market?.rentGrowth1yr)} | DOM: ${r.market?.daysOnMarket || "N/A"} days`,
      result: r.market?.marketTrend || "N/A",
      inputs: [
        { label: "Price Appreciation", value: fmtPct(r.market?.appreciation1yr), source: "Market Data" },
        { label: "Rent Growth", value: fmtPct(r.market?.rentGrowth1yr), source: "Market Data" },
        { label: "Days on Market", value: `${r.market?.daysOnMarket || "N/A"} days`, source: "MLS" },
      ],
      source: "Composite market indicator analysis",
    },

    // ── Neighborhood ──────────────────────────────────────────────────────────
    "Walk Score": {
      label: "Walk Score",
      explanation: "Walk Score (0–100) measures how walkable a location is based on proximity to amenities. Higher scores attract more renter demand and can support higher rents. 90+ = Walker's Paradise, 70+ = Very Walkable, 50+ = Somewhat Walkable.",
      formula: "Proprietary Walk Score algorithm — no calculation",
      calc: `Walk Score: ${r.neighborhood?.walkScore || "N/A"}/100 (${r.neighborhood?.walkScore >= 90 ? "Walker's Paradise" : r.neighborhood?.walkScore >= 70 ? "Very Walkable" : r.neighborhood?.walkScore >= 50 ? "Somewhat Walkable" : r.neighborhood?.walkScore >= 25 ? "Car-Dependent" : "Very Car-Dependent"})`,
      result: `${r.neighborhood?.walkScore || "N/A"}/100`,
      inputs: [
        { label: "Address", value: r.property?.address, source: "Property Data" },
        { label: "Nearby Amenities", value: "Restaurants, Grocery, Transit, Parks", source: "Walk Score Algorithm" },
      ],
      source: "Walk Score® (walkscore.com)",
    },

    "Transit Score": {
      label: "Transit Score",
      explanation: "Transit Score (0–100) measures how well-served an area is by public transportation. Higher scores reduce tenant dependence on cars and can expand your renter pool.",
      formula: "Proprietary Transit Score algorithm — no calculation",
      calc: `Transit Score: ${r.neighborhood?.transitScore || "N/A"}/100 | Bike Score: ${r.neighborhood?.bikeScore || "N/A"}/100`,
      result: `${r.neighborhood?.transitScore || "N/A"}/100`,
      inputs: [
        { label: "Address", value: r.property?.address, source: "Property Data" },
        { label: "Transit Routes Nearby", value: "Bus, Rail, Ferry within 0.25mi", source: "Walk Score Algorithm" },
      ],
      source: "Walk Score® Transit Score",
    },

    "School Rating": {
      label: "Local School Rating",
      explanation: "School quality rating (1–10) from GreatSchools or Niche. Highly rated schools drive significant rental demand from families — a key factor in long-term vacancy rates and rent premiums.",
      formula: "Third-party school rating — no calculation",
      calc: `School rating: ${r.neighborhood?.schoolRating || "N/A"}/10 (${r.neighborhood?.schoolRating >= 8 ? "Excellent — strong family demand" : r.neighborhood?.schoolRating >= 6 ? "Above Average" : r.neighborhood?.schoolRating >= 4 ? "Average" : "Below Average — may affect demand"})`,
      result: `${r.neighborhood?.schoolRating || "N/A"}/10`,
      inputs: [
        { label: "School District", value: `${r.property?.city}, ${r.property?.state}`, source: "Property Location" },
        { label: "Rating Source", value: "GreatSchools / Niche", source: "Third-Party Rating" },
      ],
      source: "GreatSchools.org / Niche.com",
    },

    "Crime Index": {
      label: "Crime Index / Safety Rating",
      explanation: "A relative measure of crime activity in the neighborhood. Lower crime correlates strongly with higher rents, better tenant quality, lower vacancy, and stronger appreciation. Always verify with local police statistics.",
      formula: "Crime index relative to national/city average — no calculation",
      calc: `Crime level: ${r.neighborhood?.crimeIndex || "N/A"}\nImpact: ${r.neighborhood?.crimeIndex?.toLowerCase()?.includes("low") ? "Positive — attracts quality tenants, supports rent premiums" : r.neighborhood?.crimeIndex?.toLowerCase()?.includes("high") ? "Negative — may increase vacancy and turnover" : "Neutral — verify with local data"}`,
      result: r.neighborhood?.crimeIndex || "N/A",
      inputs: [
        { label: "Location", value: `${r.property?.city}, ${r.property?.state}`, source: "Property Data" },
        { label: "Crime Level", value: r.neighborhood?.crimeIndex || "N/A", source: "AreaVibes / Neighborhood Scout" },
      ],
      source: "AreaVibes, NeighborhoodScout, FBI Crime Data",
    },

    "Flood Zone": {
      label: "FEMA Flood Zone Designation",
      explanation: "FEMA flood zone classification. Zone X = minimal flood risk (no flood insurance required). Zones A, AE, V = high-risk (flood insurance required by lenders, typically $800–$3,000/yr). Always verify the current FEMA FIRM panel.",
      formula: "FEMA Flood Insurance Rate Map (FIRM) — no calculation",
      calc: `Flood zone: ${r.neighborhood?.floodZone || "N/A"}\n${r.neighborhood?.floodZone?.includes("X") ? "✓ Minimal risk — flood insurance NOT required" : r.neighborhood?.floodZone?.includes("A") || r.neighborhood?.floodZone?.includes("V") ? "⚠ High-risk zone — flood insurance REQUIRED, adds cost" : "Verify with FEMA FIRM map"}`,
      result: r.neighborhood?.floodZone || "N/A",
      inputs: [
        { label: "Property Address", value: r.property?.address, source: "Property Data" },
        { label: "FEMA Zone", value: r.neighborhood?.floodZone || "N/A", source: "FEMA FIRM Panel" },
      ],
      source: "FEMA Flood Map Service Center (msc.fema.gov)",
    },

    "Median HH Income": {
      label: "Median Household Income",
      explanation: "The median annual household income in the surrounding census tract or zip code. Higher incomes support higher rents and lower default risk. A common benchmark: monthly rent should not exceed 30% of gross monthly income for the target tenant.",
      formula: "Census / ACS data — no calculation",
      calc: `Median HH income: ${fmt(r.neighborhood?.medianHouseholdIncome)} / yr (${fmt(r.neighborhood?.medianHouseholdIncome / 12)} / mo)\n30% of median income available for rent: ${fmt(r.neighborhood?.medianHouseholdIncome / 12 * 0.3)} / mo vs your est. rent ${fmt(f.monthlyRent)} / mo\nRent-to-income ratio: ${r.neighborhood?.medianHouseholdIncome ? ((f.monthlyRent / (r.neighborhood.medianHouseholdIncome / 12)) * 100).toFixed(1) + "%" : "N/A"} of gross monthly income`,
      result: fmt(r.neighborhood?.medianHouseholdIncome),
      inputs: [
        { label: "Median HH Income", value: fmt(r.neighborhood?.medianHouseholdIncome), source: "US Census ACS" },
        { label: "Monthly Income", value: fmt(r.neighborhood?.medianHouseholdIncome / 12), source: "Annual ÷ 12" },
        { label: "30% of Monthly Income", value: fmt(r.neighborhood?.medianHouseholdIncome / 12 * 0.3), source: "Affordability Benchmark" },
        { label: "Your Est. Rent", value: fmt(f.monthlyRent), source: "Market Comps" },
      ],
      source: "US Census Bureau American Community Survey (ACS)",
    },
  };
}

// ─── DSCR Loan Criteria Builder ───────────────────────────────────────────────
function buildDSCRLoanCriteria(fin, r, loan) {
  if (!fin) return null;
  const estimatedValue = n(r?.valuation?.estimatedValue) || fin.purchasePrice;
  const ltv = estimatedValue > 0 ? (fin.loanAmount / estimatedValue) * 100 : 0;
  // Lender DSCR = Gross Rent / PITIA (Principal + Interest + Taxes + Insurance + HOA)
  const pitia = fin.monthlyMortgage + n(fin.monthlyExpenses.taxes) + n(fin.monthlyExpenses.insurance) + n(fin.monthlyExpenses.hoa);
  const grossDSCR = pitia > 0 ? fin.monthlyRent / pitia : 0;
  // Investment DSCR = NOI / P&I (already in fin.dscr)
  const investDSCR = fin.dscr;
  const loanAmt = fin.loanAmount;
  const rtv = estimatedValue > 0 ? (fin.monthlyRent / estimatedValue) * 100 : 0;

  // Tier structure: each tier has label, color, min DSCR (lender gross), max LTV, verdict
  const tiers = [
    { key: "conservative", label: "Conservative", sublabel: "Portfolio / Credit Union", color: "#00ccff",   minDSCR: 1.35, maxLTV: 70,  minLoan: 100000, maxLoan: 2000000 },
    { key: "standard",     label: "Standard",     sublabel: "Most DSCR Lenders",        color: "#00ff88",   minDSCR: 1.25, maxLTV: 75,  minLoan: 75000,  maxLoan: 3500000 },
    { key: "flexible",     label: "Flexible",     sublabel: "Aggressive DSCR Lenders",  color: "#ffcc00",   minDSCR: 1.10, maxLTV: 80,  minLoan: 75000,  maxLoan: 5000000 },
    { key: "noratio",      label: "No-Ratio",     sublabel: "Specialty / Asset-Based",  color: "#ff8844",   minDSCR: 0.75, maxLTV: 80,  minLoan: 75000,  maxLoan: 5000000 },
  ];

  const criteriaRows = [
    {
      key: "grossDSCR_125",
      label: "Lender DSCR ≥ 1.25",
      sublabel: "Gross Rent ÷ PITIA",
      value: grossDSCR.toFixed(2) + "x",
      pass: grossDSCR >= 1.25,
      tiers: ["standard", "conservative"],
      derivation: {
        label: "Lender DSCR (Gross Rent ÷ PITIA)",
        explanation: "DSCR lenders calculate coverage differently than investors. They use Gross Monthly Rent divided by PITIA (Principal + Interest + Taxes + Insurance + HOA) — NOT the investor's NOI calculation. This is the primary qualifying ratio for most DSCR loan programs.",
        formula: "Gross Monthly Rent ÷ (P&I + Taxes + Insurance + HOA)",
        calc: `Gross rent: ${fmt(fin.monthlyRent)}\nPITIA: ${fmt(fin.monthlyMortgage)} (P&I) + ${fmt(fin.monthlyExpenses.taxes)} (taxes) + ${fmt(fin.monthlyExpenses.insurance)} (insurance) + ${fmt(fin.monthlyExpenses.hoa)} (HOA) = ${fmt(pitia)}\n\nLender DSCR = ${fmt(fin.monthlyRent)} ÷ ${fmt(pitia)} = ${grossDSCR.toFixed(3)}x\n\nNote: Your investor DSCR (NOI ÷ P&I) = ${investDSCR.toFixed(3)}x — lenders see a different number.`,
        result: grossDSCR.toFixed(2) + "x",
        inputs: [
          { label: "Gross Monthly Rent", value: fmt(fin.monthlyRent), source: "Market Comps" },
          { label: "Monthly P&I", value: fmt(fin.monthlyMortgage), source: `${loan.rate}% / ${loan.termYears}yr on ${fmt(fin.loanAmount)}` },
          { label: "Monthly Taxes", value: fmt(fin.monthlyExpenses.taxes), source: "County Records" },
          { label: "Monthly Insurance", value: fmt(fin.monthlyExpenses.insurance), source: "Market Rate" },
          { label: "Monthly HOA", value: fmt(fin.monthlyExpenses.hoa), source: "HOA Records" },
          { label: "PITIA Total", value: fmt(pitia), source: "Calculated" },
          { label: "Investor DSCR (for reference)", value: investDSCR.toFixed(3) + "x", source: "NOI ÷ P&I" },
        ],
        source: "DSCR lender underwriting guidelines (Gross Rent / PITIA method)",
      },
    },
    {
      key: "grossDSCR_110",
      label: "Lender DSCR ≥ 1.10",
      sublabel: "Flexible lender minimum",
      value: grossDSCR.toFixed(2) + "x",
      pass: grossDSCR >= 1.10,
      tiers: ["flexible"],
      derivation: {
        label: "Flexible Lender DSCR ≥ 1.10",
        explanation: "Some DSCR lenders accept a ratio as low as 1.10 — meaning the rent covers 110% of PITIA. These programs typically carry higher rates (+0.25–0.75%) and stricter LTV requirements as a compensating factor.",
        formula: "Gross Monthly Rent ÷ PITIA ≥ 1.10",
        calc: `${fmt(fin.monthlyRent)} ÷ ${fmt(pitia)} = ${grossDSCR.toFixed(3)}x\nThreshold: ≥ 1.10x → ${grossDSCR >= 1.10 ? "✓ QUALIFIES" : "✗ DOES NOT QUALIFY"}\nRate premium for DSCR 1.10–1.24: typically +0.25–0.50% vs standard rate`,
        result: grossDSCR.toFixed(2) + "x",
        inputs: [
          { label: "Gross Monthly Rent", value: fmt(fin.monthlyRent), source: "Market Comps" },
          { label: "PITIA", value: fmt(pitia), source: "Calculated" },
          { label: "Lender DSCR", value: grossDSCR.toFixed(3) + "x", source: "Rent ÷ PITIA" },
          { label: "Typical Rate Adj.", value: "+0.25–0.50%", source: "Lender Pricing" },
        ],
        source: "Flexible DSCR lender programs (e.g. Griffin Funding, Visio, Kiavi)",
      },
    },
    {
      key: "grossDSCR_075",
      label: "DSCR ≥ 0.75 (No-Ratio)",
      sublabel: "Asset-based / specialty lenders",
      value: grossDSCR.toFixed(2) + "x",
      pass: grossDSCR >= 0.75,
      tiers: ["noratio"],
      derivation: {
        label: "No-Ratio / Below-1.0 DSCR Programs",
        explanation: "Some specialty and asset-based lenders will lend on properties with DSCR below 1.0 — even as low as 0.75. These are typically bridge lenders or hard money lenders who qualify based heavily on borrower net worth, liquidity, and credit. Rates are significantly higher (often 9–12%+) and terms shorter.",
        formula: "Gross Rent ÷ PITIA ≥ 0.75 (minimum for most no-ratio programs)",
        calc: `Lender DSCR: ${grossDSCR.toFixed(3)}x → ${grossDSCR >= 0.75 ? "✓ Meets minimum for no-ratio programs" : "✗ Below 0.75 — very few programs available"}\nTypical compensating requirements:\n  • Borrower net worth ≥ 2× loan amount\n  • 12+ months reserves\n  • Credit score ≥ 700\n  • LTV ≤ 65%\n  • Rate premium: typically +2–4% vs conventional DSCR`,
        result: grossDSCR.toFixed(2) + "x",
        inputs: [
          { label: "Lender DSCR", value: grossDSCR.toFixed(3) + "x", source: "Rent ÷ PITIA" },
          { label: "Minimum Threshold", value: "0.75x (most programs)", source: "Specialty Lender Guidelines" },
          { label: "Typical Rate", value: "9–12%+", source: "Market Pricing" },
        ],
        source: "Asset-based / bridge lender programs",
      },
    },
    {
      key: "ltv_75",
      label: "LTV ≤ 75%",
      sublabel: "Standard DSCR lender max",
      value: ltv.toFixed(1) + "%",
      pass: ltv <= 75,
      tiers: ["standard", "conservative"],
      derivation: {
        label: "Loan-to-Value Ratio (LTV) ≤ 75%",
        explanation: "Most DSCR lenders cap LTV at 70–75% for purchase loans (vs 80% for conventional). This means a minimum 25% down payment. Lower LTV = lower risk for the lender = better rate for you.",
        formula: "Loan Amount ÷ Property Value × 100",
        calc: `Loan amount: ${fmt(fin.loanAmount)}\nProperty value (AVM): ${fmt(estimatedValue)}\nLTV = ${fmt(fin.loanAmount)} ÷ ${fmt(estimatedValue)} × 100 = ${ltv.toFixed(2)}%\n\nDown payment: ${fmt(fin.downPayment)} (${loan.downPct}%)\nLTV threshold: 75% → ${ltv <= 75 ? "✓ QUALIFIES" : "✗ Exceeds max — need more down payment"}\n${ltv > 75 ? `Additional down payment needed: ${fmt((ltv - 75) / 100 * estimatedValue)}` : `LTV cushion: ${(75 - ltv).toFixed(1)}% below threshold`}`,
        result: ltv.toFixed(1) + "%",
        inputs: [
          { label: "Loan Amount", value: fmt(fin.loanAmount), source: "Calculated" },
          { label: "Property Value (AVM)", value: fmt(estimatedValue), source: "Zillow / Redfin" },
          { label: "Down Payment", value: `${fmt(fin.downPayment)} (${loan.downPct}%)`, source: "Loan Settings" },
          { label: "Standard DSCR Max LTV", value: "75%", source: "Lender Guidelines" },
          { label: "LTV Cushion", value: ltv <= 75 ? (75 - ltv).toFixed(1) + "% below limit" : (ltv - 75).toFixed(1) + "% above limit", source: "Calculated" },
        ],
        source: "Standard DSCR lender LTV requirements",
      },
    },
    {
      key: "ltv_80",
      label: "LTV ≤ 80%",
      sublabel: "Flexible lender max",
      value: ltv.toFixed(1) + "%",
      pass: ltv <= 80,
      tiers: ["flexible", "noratio"],
      derivation: {
        label: "LTV ≤ 80% (Flexible Lender Maximum)",
        explanation: "Some DSCR lenders allow up to 80% LTV — requiring as little as 20% down — but this typically comes with a slightly higher rate and stricter DSCR requirements. Going above 75% LTV often adds 0.25–0.50% to the rate.",
        formula: "Loan Amount ÷ Property Value × 100 ≤ 80%",
        calc: `LTV: ${fmt(fin.loanAmount)} ÷ ${fmt(estimatedValue)} × 100 = ${ltv.toFixed(2)}%\nThreshold: ≤ 80% → ${ltv <= 80 ? "✓ QUALIFIES" : "✗ EXCEEDS maximum"}\nRate premium for LTV 75–80%: typically +0.25–0.50%`,
        result: ltv.toFixed(1) + "%",
        inputs: [
          { label: "Loan Amount", value: fmt(fin.loanAmount), source: "Calculated" },
          { label: "Property Value", value: fmt(estimatedValue), source: "AVM" },
          { label: "Rate Premium (75–80% LTV)", value: "+0.25–0.50%", source: "Lender Pricing" },
        ],
        source: "Flexible DSCR lender guidelines",
      },
    },
    {
      key: "loanMin",
      label: "Loan ≥ $75,000",
      sublabel: "Minimum loan size",
      value: fmt(loanAmt),
      pass: loanAmt >= 75000,
      tiers: ["standard", "flexible", "noratio"],
      derivation: {
        label: "Minimum Loan Amount ($75,000)",
        explanation: "Most DSCR lenders have a minimum loan size of $75,000–$100,000 because the fixed origination costs (appraisal, title, underwriting) don't scale well below that threshold. Some lenders set the minimum at $150,000.",
        formula: "Loan Amount ≥ $75,000",
        calc: `Loan amount: ${fmt(loanAmt)}\nMinimum threshold: $75,000\n${loanAmt >= 75000 ? `✓ ${fmt(loanAmt - 75000)} above minimum` : `✗ ${fmt(75000 - loanAmt)} below minimum`}`,
        result: fmt(loanAmt),
        inputs: [
          { label: "Loan Amount", value: fmt(loanAmt), source: "Purchase Price − Down Payment" },
          { label: "Industry Minimum", value: "$75,000–$100,000", source: "Lender Guidelines" },
        ],
        source: "Standard DSCR lender minimum loan size requirements",
      },
    },
    {
      key: "loanMax",
      label: "Loan ≤ $3,500,000",
      sublabel: "Standard program max",
      value: fmt(loanAmt),
      pass: loanAmt <= 3500000,
      tiers: ["standard"],
      derivation: {
        label: "Maximum Loan Amount ($3,500,000)",
        explanation: "Most standard DSCR loan programs cap out at $3–3.5M. Loans above this typically require jumbo DSCR programs (available from some lenders up to $5M) or portfolio solutions. Larger loans face more scrutiny and potentially higher rates.",
        formula: "Loan Amount ≤ $3,500,000",
        calc: `Loan amount: ${fmt(loanAmt)}\nStandard program max: $3,500,000\n${loanAmt <= 3500000 ? "✓ Within standard program limits" : `✗ ${fmt(loanAmt - 3500000)} over standard limit — jumbo DSCR program required`}\nJumbo DSCR programs available up to $5,000,000 from select lenders`,
        result: fmt(loanAmt),
        inputs: [
          { label: "Loan Amount", value: fmt(loanAmt), source: "Calculated" },
          { label: "Standard Max", value: "$3,500,000", source: "Standard DSCR Programs" },
          { label: "Jumbo Max (select lenders)", value: "$5,000,000", source: "Jumbo DSCR Programs" },
        ],
        source: "Standard DSCR lender program limits",
      },
    },
    {
      key: "rentCoversPITIA",
      label: "Rent Covers PITIA",
      sublabel: "Gross rent ≥ full housing cost",
      value: `${fmt(fin.monthlyRent)} vs ${fmt(pitia)}`,
      pass: fin.monthlyRent >= pitia,
      tiers: ["standard", "conservative"],
      derivation: {
        label: "Gross Rent Covers PITIA",
        explanation: "A fundamental lender check: does the gross rent at least equal the full monthly housing payment (PITIA)? If rent < PITIA, the property loses money before operating expenses, which most lenders treat as an automatic concern.",
        formula: "Monthly Rent ≥ Monthly PITIA",
        calc: `Monthly rent: ${fmt(fin.monthlyRent)}\nPITIA: ${fmt(pitia)} (P&I ${fmt(fin.monthlyMortgage)} + taxes ${fmt(fin.monthlyExpenses.taxes)} + insurance ${fmt(fin.monthlyExpenses.insurance)} + HOA ${fmt(fin.monthlyExpenses.hoa)})\n\nSurplus / (Deficit): ${fmt(fin.monthlyRent - pitia)} / mo (${((fin.monthlyRent / pitia - 1) * 100).toFixed(1)}% cushion)\n\n${fin.monthlyRent >= pitia ? "✓ Rent covers full PITIA" : "✗ Rent does not cover PITIA — property loses money before operating expenses"}`,
        result: fin.monthlyRent >= pitia ? "✓ Covered" : "✗ Shortfall",
        inputs: [
          { label: "Monthly Rent", value: fmt(fin.monthlyRent), source: "Market Comps" },
          { label: "Monthly PITIA", value: fmt(pitia), source: "Calculated" },
          { label: "Surplus / Deficit", value: fmt(fin.monthlyRent - pitia) + "/mo", source: "Calculated" },
          { label: "Coverage Cushion", value: ((fin.monthlyRent / pitia - 1) * 100).toFixed(1) + "%", source: "Calculated" },
        ],
        source: "DSCR lender underwriting — rent vs PITIA check",
      },
    },
    {
      key: "rtv",
      label: "Rent-to-Value ≥ 0.75%",
      sublabel: "Monthly rent ÷ property value",
      value: rtv.toFixed(3) + "%",
      pass: rtv >= 0.0075,
      tiers: ["flexible"],
      derivation: {
        label: "Rent-to-Value Ratio (RTV) ≥ 0.75%",
        explanation: "Some lenders screen for a minimum rent-to-value ratio — typically 0.75–1.0% of the property value per month. This is similar to the '1% Rule' investors use. A low RTV suggests the rent is insufficient relative to the asset price, creating DSCR risk if rates or expenses rise.",
        formula: "Monthly Rent ÷ Property Value × 100",
        calc: `Monthly rent: ${fmt(fin.monthlyRent)}\nProperty value: ${fmt(estimatedValue)}\nRTV = ${fmt(fin.monthlyRent)} ÷ ${fmt(estimatedValue)} × 100 = ${rtv.toFixed(3)}%\n\n1% Rule threshold: ${fmt(estimatedValue * 0.01)}/mo → ${fin.monthlyRent >= estimatedValue * 0.01 ? "✓ Meets 1% Rule" : "✗ Below 1% Rule"}\n0.75% minimum: ${fmt(estimatedValue * 0.0075)}/mo → ${rtv >= 0.75 ? "✓ Meets 0.75%" : "✗ Below 0.75%"}`,
        result: rtv.toFixed(3) + "%",
        inputs: [
          { label: "Monthly Rent", value: fmt(fin.monthlyRent), source: "Market Comps" },
          { label: "Property Value", value: fmt(estimatedValue), source: "AVM" },
          { label: "RTV", value: rtv.toFixed(3) + "%", source: "Rent ÷ Value" },
          { label: "1% Rule Rent Target", value: fmt(estimatedValue * 0.01) + "/mo", source: "Investor Benchmark" },
          { label: "0.75% Lender Min", value: fmt(estimatedValue * 0.0075) + "/mo", source: "Lender Guideline" },
        ],
        source: "Select DSCR lender RTV requirements",
      },
    },
  ];

  // Evaluate each tier
  const tierResults = tiers.map(tier => {
    const relevant = criteriaRows.filter(c => c.tiers.includes(tier.key));
    const passCount = relevant.filter(c => c.pass).length;
    const qualifies = relevant.every(c => c.pass);
    return { ...tier, criteria: relevant, passCount, totalCount: relevant.length, qualifies };
  });

  return { tierResults, criteriaRows, grossDSCR, ltv, pitia, investDSCR, rtv };
}

// ─── Derivation Modal ─────────────────────────────────────────────────────────
function DerivationModal({ data, onClose }) {
  if (!data) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, backdropFilter: "blur(6px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#13131e", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, maxWidth: 540, width: "100%", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 40px 80px rgba(0,0,0,0.7)" }}>
        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "'Space Mono',monospace", letterSpacing: "0.15em", marginBottom: 5 }}>HOW THIS WAS DERIVED</div>
            <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.3 }}>{data.label}</div>
          </div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.07)", border: "none", color: "rgba(255,255,255,0.5)", width: 30, height: 30, borderRadius: "50%", fontSize: 16, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>

        <div style={{ padding: "18px 24px 24px", display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Result */}
          <div style={{ background: "rgba(0,255,136,0.06)", border: "1px solid rgba(0,255,136,0.15)", borderRadius: 10, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontFamily: "'Space Mono',monospace" }}>RESULT</span>
            <span style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#00ff88" }}>{data.result}</span>
          </div>

          {/* Explanation */}
          <div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.12em", marginBottom: 7 }}>WHAT THIS MEANS</div>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.65, margin: 0 }}>{data.explanation}</p>
          </div>

          {/* Formula */}
          <div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.12em", marginBottom: 7 }}>FORMULA</div>
            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "10px 14px", fontSize: 12, fontFamily: "'Space Mono',monospace", color: "#ffcc00", lineHeight: 1.5 }}>
              {data.formula}
            </div>
          </div>

          {/* Calculation with numbers */}
          <div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.12em", marginBottom: 7 }}>CALCULATION WITH ACTUAL NUMBERS</div>
            <div style={{ background: "rgba(255,204,0,0.05)", border: "1px solid rgba(255,204,0,0.15)", borderRadius: 8, padding: "12px 14px", fontSize: 12, fontFamily: "'Space Mono',monospace", color: "rgba(255,255,255,0.8)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
              {data.calc}
            </div>
          </div>

          {/* Inputs used */}
          {data.inputs?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.12em", marginBottom: 7 }}>DATA INPUTS USED</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)" }}>
                {data.inputs.map((inp, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "9px 14px", background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent", gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{inp.label}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>{inp.source}</div>
                    </div>
                    <div style={{ fontSize: 12, fontFamily: "'Space Mono',monospace", color: "#fff", fontWeight: 600, textAlign: "right", flexShrink: 0 }}>{inp.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Source */}
          <div style={{ padding: "10px 14px", background: "rgba(0,204,255,0.04)", border: "1px solid rgba(0,204,255,0.1)", borderRadius: 8 }}>
            <span style={{ fontSize: 10, color: "rgba(0,204,255,0.7)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.1em" }}>DATA SOURCE: </span>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{data.source}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DSCR Loan Section Component ─────────────────────────────────────────────
function DSCRLoanSection({ qual, onShowDerivation }) {
  const [expanded, setExpanded] = useState(true);
  if (!qual) return null;

  const { lenderDscr, pitia, rent, ltv, reservesNeeded, tiers, highestTier, universalChecks, pi, taxes, insurance, hoa } = qual;

  const overallColor = highestTier?.id === "A" ? "#00ff88" : highestTier?.id === "B" ? "#ffcc00" : highestTier?.id === "C" ? "#ff8844" : "#ff4444";
  const overallLabel = highestTier ? `QUALIFIES — ${highestTier.label}` : "DOES NOT QUALIFY";

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Section Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: "#00ccff", textTransform: "uppercase", letterSpacing: "0.15em", fontFamily: "'Space Mono',monospace" }}>DSCR Loan Qualification</span>
        <div style={{ flex: 1, height: 1, background: "rgba(0,204,255,0.2)" }} />
        <button onClick={() => setExpanded(e => !e)} style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "3px 10px", fontFamily: "'Space Mono',monospace" }}>
          {expanded ? "▲ collapse" : "▼ expand"}
        </button>
      </div>

      {/* Summary bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, padding: "14px 20px", background: `${overallColor}0d`, border: `1px solid ${overallColor}33`, borderRadius: 12, marginBottom: expanded ? 14 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.1em", marginBottom: 3 }}>LENDER DSCR (Rent ÷ PITIA)</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: overallColor, lineHeight: 1 }}>{lenderDscr.toFixed(2)}x</div>
          </div>
          <div style={{ width: 1, height: 36, background: "rgba(255,255,255,0.1)" }} />
          <div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>MONTHLY PITIA</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#fff" }}>{fmt(pitia)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>GROSS RENT</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#00ccff" }}>{fmt(rent)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>LTV</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: ltv <= 75 ? "#00ff88" : ltv <= 80 ? "#ffcc00" : "#ff4444" }}>{ltv.toFixed(1)}%</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <span style={{ background: overallColor, color: "#000", fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 11, padding: "5px 14px", borderRadius: 20, letterSpacing: "0.1em", whiteSpace: "nowrap" }}>{overallLabel}</span>
          {highestTier && <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>Est. rate: {highestTier.rateEst}</span>}
        </div>
      </div>

      {expanded && (
        <>
          {/* Tier Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
            {tiers.map(tier => {
              const allPass = tier.qualified;
              const col = allPass ? tier.color : "rgba(255,255,255,0.15)";
              return (
                <div key={tier.id} style={{ background: allPass ? `${tier.color}08` : "rgba(255,255,255,0.02)", border: `1px solid ${allPass ? tier.color + "33" : "rgba(255,255,255,0.08)"}`, borderRadius: 12, padding: "16px", position: "relative", overflow: "hidden" }}>
                  {/* Tier badge */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: allPass ? tier.color : "rgba(255,255,255,0.4)", fontFamily: "'Space Mono',monospace" }}>{tier.label}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 3, lineHeight: 1.4 }}>{tier.desc}</div>
                    </div>
                    <span style={{ fontSize: 10, padding: "3px 8px", borderRadius: 12, background: allPass ? `${tier.color}22` : "rgba(255,68,68,0.15)", color: allPass ? tier.color : "#ff6666", fontFamily: "'Space Mono',monospace", fontWeight: 700, flexShrink: 0, marginLeft: 6 }}>
                      {allPass ? "✓ PASS" : "✗ FAIL"}
                    </span>
                  </div>

                  {/* Checks */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {tier.checks.map(chk => (
                      <div key={chk.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ fontSize: 11, color: chk.pass ? "#00ff88" : "#ff5555" }}>{chk.pass ? "✓" : "✗"}</span>
                          <div>
                            <div style={{ fontSize: 11, color: chk.pass ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.45)" }}>{chk.label}</div>
                            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "'Space Mono',monospace" }}>need {chk.need}</div>
                          </div>
                        </div>
                        <span style={{ fontSize: 11, fontFamily: "'Space Mono',monospace", fontWeight: 700, color: chk.pass ? (tier.color) : "#ff5555", flexShrink: 0 }}>{chk.value}</span>
                      </div>
                    ))}
                  </div>

                  {/* Rate & Lenders */}
                  {allPass && (
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 3 }}>EST. DSCR LOAN RATE</div>
                      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: tier.color }}>{tier.rateEst}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 5, lineHeight: 1.4 }}>{tier.lenders}</div>
                    </div>
                  )}
                  {!allPass && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 10, color: "rgba(255,68,68,0.6)", lineHeight: 1.4 }}>
                        {tier.checks.filter(c => !c.pass).map(c => `${c.label} below threshold`).join(" · ")}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Universal checks + PITIA breakdown */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {/* Universal pass/fail */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "16px" }}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.1em", marginBottom: 12 }}>UNIVERSAL CHECKS</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {universalChecks.map(chk => (
                  <div key={chk.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 11, color: chk.pass ? "#00ff88" : "#ff5555", marginTop: 1, flexShrink: 0 }}>{chk.pass ? "✓" : "✗"}</span>
                      <div>
                        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>{chk.label}</div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 1 }}>{chk.detail}</div>
                      </div>
                    </div>
                    <span style={{ fontSize: 11, fontFamily: "'Space Mono',monospace", fontWeight: 700, color: chk.pass ? "#00ff88" : "#ff5555", flexShrink: 0 }}>{chk.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* PITIA breakdown */}
            <div style={{ background: "rgba(0,204,255,0.03)", border: "1px solid rgba(0,204,255,0.1)", borderRadius: 12, padding: "16px" }}>
              <div style={{ fontSize: 11, color: "rgba(0,204,255,0.7)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.1em", marginBottom: 12 }}>PITIA BREAKDOWN</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 10, lineHeight: 1.5 }}>
                Lenders use PITIA — not full NOI — to calculate DSCR. Management, maintenance, vacancy & CapEx are excluded from lender DSCR.
              </div>
              {[
                ["Principal & Interest (P&I)", fmt(pi)],
              ["Property Taxes",             fmt(taxes)],
              ["Insurance",                  fmt(insurance)],
              ["HOA",                        fmt(hoa)],
              ].map(([l, v]) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: 12 }}>
                  <span style={{ color: "rgba(255,255,255,0.45)" }}>{l}</span>
                  <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 600, color: "#fff" }}>{v}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 4px", fontSize: 13 }}>
                <span style={{ color: "#00ccff", fontWeight: 600 }}>TOTAL PITIA</span>
                <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, color: "#00ccff" }}>{fmt(pitia)}</span>
              </div>
              <div style={{ marginTop: 12, padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 4 }}>RESERVES REQUIRED AT CLOSING</div>
                <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#ffcc00" }}>{fmt(reservesNeeded)}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>{qual.dc.reservesMonths} months × {fmt(pitia)} PITIA — must be liquid</div>
              </div>
            </div>
          </div>

          {/* Lender note */}
          <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, fontSize: 11, color: "rgba(255,255,255,0.3)", lineHeight: 1.6 }}>
            <strong style={{ color: "rgba(255,255,255,0.45)" }}>DSCR Loan Notes:</strong> No W-2/tax returns required. Qualification based entirely on rental income vs. PITIA. Rates shown are estimated premiums above conventional — actual rates vary by lender, credit score, and market. Adjust criteria in ⚙ CRITERIA & EXPENSES → DSCR Loan tab.
          </div>
        </>
      )}
    </div>
  );
}


function MetricCard({ label, value, sub, color = "#00ff88", pass, showPass, derivation, onShowDerivation }) {
  const clickable = !!derivation;
  return (
    <div
      onClick={clickable ? () => onShowDerivation(derivation) : undefined}
      title={clickable ? "Click to see how this was calculated" : undefined}
      style={{
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${showPass !== undefined ? (pass ? "rgba(0,255,136,0.2)" : "rgba(255,68,68,0.25)") : "rgba(255,255,255,0.08)"}`,
        borderRadius: 12, padding: "14px 16px",
        display: "flex", flexDirection: "column", gap: 4, position: "relative",
        cursor: clickable ? "pointer" : "default",
        transition: "all 0.15s",
      }}
      onMouseEnter={e => { if (clickable) { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.borderColor = "rgba(0,255,136,0.25)"; } }}
      onMouseLeave={e => { if (clickable) { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; e.currentTarget.style.borderColor = showPass !== undefined ? (pass ? "rgba(0,255,136,0.2)" : "rgba(255,68,68,0.25)") : "rgba(255,255,255,0.08)"; } }}
    >
      {showPass !== undefined && <div style={{ position: "absolute", top: 10, right: clickable ? 26 : 10, width: 7, height: 7, borderRadius: "50%", background: pass ? "#00ff88" : "#ff4444", boxShadow: `0 0 6px ${pass ? "#00ff88" : "#ff4444"}` }} />}
      {clickable && <div style={{ position: "absolute", top: 10, right: 10, fontSize: 10, color: "rgba(255,255,255,0.2)" }}>ⓘ</div>}
      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "'Space Mono',monospace", paddingRight: 20 }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color, fontFamily: "'Space Mono',monospace", lineHeight: 1.1 }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 1 }}>{sub}</span>}
    </div>
  );
}

// Clickable row for expense/deal tables
function ClickableRow({ label, value, color, derivation, onShowDerivation, isOvr }) {
  const clickable = !!derivation;
  return (
    <div
      onClick={clickable ? () => onShowDerivation(derivation) : undefined}
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: 13, cursor: clickable ? "pointer" : "default", borderRadius: 4, transition: "background 0.1s" }}
      onMouseEnter={e => { if (clickable) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
      onMouseLeave={e => { if (clickable) e.currentTarget.style.background = "transparent"; }}
      title={clickable ? "Click to see how this was calculated" : undefined}
    >
      <span style={{ color: isOvr ? "#ffcc00" : "rgba(255,255,255,0.45)", display: "flex", alignItems: "center", gap: 6 }}>
        {label}{isOvr ? " ✎" : ""}
        {clickable && <span style={{ fontSize: 9, color: "rgba(255,255,255,0.2)" }}>ⓘ</span>}
      </span>
      <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 600, color: isOvr ? "#ffcc00" : (color || "#fff") }}>{value}</span>
    </div>
  );
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function Section({ title, children, accent }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: accent || "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.15em", fontFamily: "'Space Mono',monospace" }}>{title}</span>
        <div style={{ flex: 1, height: 1, background: accent ? `${accent}30` : "rgba(255,255,255,0.06)" }} />
      </div>
      {children}
    </div>
  );
}

function ScoreMeter({ passFail }) {
  const passCount = passFail?.filter(c => c.pass).length || 0;
  const total = passFail?.length || 8;
  const pct = passCount / total;
  const color = pct >= 0.75 ? "#00ff88" : pct >= 0.5 ? "#ffcc00" : "#ff4444";
  const label = pct >= 0.75 ? "BUY" : pct >= 0.5 ? "HOLD" : "PASS";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <svg width={130} height={75} viewBox="0 0 140 80">
        <defs><linearGradient id="sg" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#ff4444" /><stop offset="50%" stopColor="#ffcc00" /><stop offset="100%" stopColor="#00ff88" /></linearGradient></defs>
        <path d="M 10 75 A 60 60 0 0 1 130 75" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={10} strokeLinecap="round" />
        <path d="M 10 75 A 60 60 0 0 1 130 75" fill="none" stroke="url(#sg)" strokeWidth={10} strokeLinecap="round" strokeDasharray={`${pct * 188} 188`} />
        <text x={70} y={62} textAnchor="middle" fill={color} fontSize={22} fontWeight={700} fontFamily="'Space Mono',monospace">{passCount}/{total}</text>
        <text x={70} y={76} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize={9} fontFamily="'Space Mono',monospace" letterSpacing={1}>CRITERIA</text>
      </svg>
      <span style={{ background: color, color: "#000", fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 13, padding: "4px 16px", borderRadius: 20, letterSpacing: "0.15em" }}>{label}</span>
    </div>
  );
}

function NumInput({ label, value, onChange, prefix, suffix, step = 1, min, hint }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, overflow: "hidden" }}>
        {prefix && <span style={{ padding: "0 8px", color: "rgba(255,255,255,0.35)", fontSize: 13, fontFamily: "'Space Mono',monospace" }}>{prefix}</span>}
        <input type="number" value={value} step={step} min={min} onChange={e => onChange(parseFloat(e.target.value) || 0)}
          style={{ flex: 1, background: "transparent", border: "none", padding: "9px 8px", color: "#fff", fontSize: 13, fontFamily: "'Space Mono',monospace", outline: "none", width: 0 }} />
        {suffix && <span style={{ padding: "0 8px", color: "rgba(255,255,255,0.35)", fontSize: 13, fontFamily: "'Space Mono',monospace" }}>{suffix}</span>}
      </div>
      {hint && <span style={{ fontSize: 10, color: "rgba(255,255,255,0.22)", lineHeight: 1.4 }}>{hint}</span>}
    </div>
  );
}

function ExpenseRow({ label, origValue, overrideValue, onChange, onReset }) {
  const isOvr = overrideValue !== null && overrideValue !== undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <label style={{ fontSize: 11, color: isOvr ? "#ffcc00" : "rgba(255,255,255,0.4)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}{isOvr ? " ✎" : ""}</label>
        {isOvr && <button onClick={onReset} style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", background: "none", border: "none", padding: 0, fontFamily: "'Space Mono',monospace" }}>reset ({fmt(origValue)})</button>}
      </div>
      <div style={{ display: "flex", alignItems: "center", background: isOvr ? "rgba(255,204,0,0.06)" : "rgba(255,255,255,0.05)", border: `1px solid ${isOvr ? "rgba(255,204,0,0.25)" : "rgba(255,255,255,0.1)"}`, borderRadius: 8, overflow: "hidden", transition: "all 0.2s" }}>
        <span style={{ padding: "0 8px", color: "rgba(255,255,255,0.35)", fontSize: 13, fontFamily: "'Space Mono',monospace" }}>$</span>
        <input type="number" value={isOvr ? overrideValue : (origValue ?? "")} placeholder={origValue != null ? String(Math.round(origValue)) : "0"} min={0}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          style={{ flex: 1, background: "transparent", border: "none", padding: "9px 8px", color: isOvr ? "#ffcc00" : "#fff", fontSize: 13, fontFamily: "'Space Mono',monospace", outline: "none", width: 0 }} />
        <span style={{ padding: "0 8px", color: "rgba(255,255,255,0.22)", fontSize: 10 }}>/mo</span>
      </div>
    </div>
  );
}

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert real estate underwriter specializing in single-family rental (SFR) properties. When given a property address or Zillow link, use web search to gather all available data and produce a comprehensive underwriting report.

Search for and include:
1. Property Details: Address, beds/baths, sqft, lot size, year built, property type, garage, pool, HOA
2. Valuation: Zestimate or AVM, last sale price & date, price per sqft
3. Rental Market: Estimated market rent, rent per sqft, rent range low/high, vacancy rate, avg days to rent
4. Neighborhood: Walk score, transit score, bike score, school ratings, crime index, flood zone, median household income
5. Market Trends: Appreciation 1yr/3yr/5yr, days on market, rent growth 1yr, market trend
6. Financial Analysis — calculate all using actual data:
   - GRM, Cap Rate, Cash-on-Cash, Monthly Cash Flow, Annual NOI, DSCR, Break-even occupancy
   - Monthly expense breakdown: taxes, insurance, maintenance, management, vacancy, capex, hoa
7. Investment Rating 1-10, recommendation, summary
8. Risks & Opportunities (4-6 each)

CRITICAL — ASKING PRICE / LISTING STATUS CONSISTENCY:

ZILLOW PAGE LAYOUT GUIDE: On an active Zillow listing page, the asking price is the FIRST large dollar amount displayed at the very top of the page, near the property photos and address. It does NOT have a label like "Listed for" — it is simply shown as "$XYZ,000" in a large bold font as the headline. Below or beside it you will see beds/baths/sqft. The Zestimate is shown SEPARATELY in its own labeled section ("Zestimate®") usually further down the page. These are TWO DIFFERENT NUMBERS, often differing by 5–15%, and they must NOT be confused.

THREE VALUATION FIELDS (distinct — do not conflate):
- valuation.listPrice = current asking price on the active listing (the headline dollar amount on Zillow's listing page)
- valuation.estimatedValue = Zillow Zestimate / AVM (algorithmic estimate, shown in its own labeled section)
- valuation.lastSalePrice = historical price of the most recent prior sale (shown in price history or "Sold on")

CONSISTENCY RULE (must hold without exception):
- If the property IS listed for sale → BOTH valuation.listPrice > 0 AND market.daysOnMarket > 0
- If the property is NOT listed → BOTH valuation.listPrice = 0 AND market.daysOnMarket = 0

NEVER report market.daysOnMarket > 0 alongside valuation.listPrice = 0 — that is internally contradictory and means you missed extracting the asking price. If you found a "days on market" number, the listing IS active and the asking price IS on the SAME page near the top; you must capture both.

If the user provided a Zillow URL in their message, that exact page contains the asking price as a large dollar amount near the top. Extract that dollar amount into valuation.listPrice.

Respond ONLY with a valid JSON object (no markdown, no backticks):
{"property":{"address":"","city":"","state":"","zip":"","beds":0,"baths":0,"sqft":0,"lotSqft":0,"yearBuilt":0,"garage":"","pool":false,"hoa":0,"propertyType":""},"valuation":{"estimatedValue":0,"listPrice":0,"lastSalePrice":0,"lastSaleDate":"","pricePerSqft":0,"priceHistory":[]},"rental":{"estimatedMonthlyRent":0,"rentPerSqft":0,"rentRange":{"low":0,"high":0},"vacancyRate":0,"averageDaysToRent":0},"neighborhood":{"walkScore":0,"transitScore":0,"bikeScore":0,"schoolRating":0,"crimeIndex":"","floodZone":"","medianHouseholdIncome":0,"employmentRate":0},"market":{"appreciation1yr":0,"appreciation3yr":0,"appreciation5yr":0,"daysOnMarket":0,"rentGrowth1yr":0,"marketTrend":""},"financials":{"purchasePrice":0,"downPayment":0,"loanAmount":0,"monthlyMortgage":0,"monthlyRent":0,"monthlyExpenses":{"taxes":0,"insurance":0,"maintenance":0,"management":0,"vacancy":0,"capex":0,"hoa":0,"total":0},"monthlyNOI":0,"annualNOI":0,"monthlyCashFlow":0,"annualCashFlow":0,"capRate":0,"cashOnCash":0,"grm":0,"dscr":0,"breakEvenOccupancy":0},"rating":{"score":0,"recommendation":"","summary":""},"risks":[],"opportunities":[],"dataSources":[],"analysisDate":"","disclaimer":""}`;

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function SFRUnderwriter() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [rawReport, setRawReport] = useState(null);
  const [error, setError] = useState("");
  const [stage, setStage] = useState("");
  const [criteria, setCriteria] = useState(DEFAULT_CRITERIA);
  const [expOvr, setExpOvr] = useState(DEFAULT_EXPENSE_OVERRIDES);
  const [loan, setLoan] = useState(DEFAULT_LOAN);
  const [dscrCriteria, setDscrCriteria] = useState(DEFAULT_DSCR_CRITERIA);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState("criteria");
  const [modal, setModal] = useState(null);
  const inputRef = useRef();

  const fin = useMemo(() => recalcFinancials(rawReport, expOvr, loan), [rawReport, expOvr, loan]);
  const pf  = useMemo(() => evaluateCriteria(fin, rawReport?.rental, rawReport?.market, criteria), [fin, rawReport, criteria]);
  const derivations = useMemo(() => buildDerivations(rawReport, fin, loan), [rawReport, fin, loan]);
  const dscrQual = useMemo(() => buildDSCRQualification(fin, rawReport, dscrCriteria), [fin, rawReport, dscrCriteria]);
  const maxPrices = useMemo(() => {
    if (!rawReport || !fin) return null;
    const defs = [
      { label: "Monthly Cash Flow", test: f => !!f && f.monthlyCashFlow     >= criteria.minMonthlyCashFlow, threshold: `${'≥'} ${fmt(criteria.minMonthlyCashFlow)}/mo` },
      { label: "Cap Rate",          test: f => !!f && f.capRate             >= criteria.minCapRate,         threshold: `${'≥'} ${criteria.minCapRate}%` },
      { label: "Cash-on-Cash",      test: f => !!f && f.cashOnCash          >= criteria.minCashOnCash,      threshold: `${'≥'} ${criteria.minCashOnCash}%` },
      { label: "DSCR",              test: f => !!f && f.dscr                >= criteria.minDSCR,            threshold: `${'≥'} ${criteria.minDSCR}` },
      { label: "GRM",               test: f => !!f && f.grm                 <= criteria.maxGRM,             threshold: `${'≤'} ${criteria.maxGRM}` },
      { label: "Break-Even Occ.",   test: f => !!f && f.breakEvenOccupancy  <= criteria.maxBreakEven,       threshold: `${'≤'} ${criteria.maxBreakEven}%` },
    ];
    return defs.map(d => ({
      label: d.label,
      threshold: d.threshold,
      maxPrice: solveMaxPrice(d.test, rawReport, expOvr, loan),
      currentPass: d.test(fin),
    }));
  }, [rawReport, fin, expOvr, loan, criteria]);
  const passCount = pf.filter(c => c.pass).length;
  const hasOvr = Object.values(expOvr).some(v => v !== null);
  const origExp = rawReport?.financials?.monthlyExpenses || {};

  const showD = useCallback((key) => { if (derivations[key]) setModal(derivations[key]); }, [derivations]);

  async function runUnderwriting() {
    if (!input.trim()) return;
    setLoading(true); setError(""); setRawReport(null); setExpOvr(DEFAULT_EXPENSE_OVERRIDES); setModal(null);
    const stages = ["Locating property data...","Pulling valuation & comps...","Analyzing rental market...","Scoring neighborhood...","Running financial models...","Generating report..."];
    let si = 0; setStage(stages[0]);
    const iv = setInterval(() => { si = (si + 1) % stages.length; setStage(stages[si]); }, 3500);
    try {
      const res = await fetch("/api/underwrite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 16000, system: SYSTEM_PROMPT,
          tools: [
            { type: "web_fetch_20250910", name: "web_fetch" },
            { type: "web_search_20250305", name: "web_search" },
          ],
          messages: [{ role: "user", content: `Fully underwrite this SFR: ${input.trim()}\n\nTOOL USAGE: If the input above is a URL (Zillow, Redfin, etc.), use web_fetch FIRST to directly retrieve that page — that returns the LIVE current asking price and days on market without indexing lag. If the input is only an address, use web_search to locate the listing URL, then web_fetch the listing page directly. Always prefer web_fetch over web_search for the listing page itself.\n\nReturn only the JSON.` }]
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error + (data.detail ? ": " + data.detail : ""));
      const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const s = raw.indexOf("{"), e2 = raw.lastIndexOf("}");
      if (s < 0 || e2 < 0 || e2 < s) {
        const stop = data.stop_reason ? " (stop_reason: " + data.stop_reason + ")" : "";
        throw new Error("Model did not return a complete JSON report" + stop + ". Try again or use a Zillow link.");
      }
      setRawReport(JSON.parse(raw.slice(s, e2 + 1)));
    } catch (err) {
        const m = err.message || "";
        let friendly;
        if (m.includes("rate_limit_error") || m.includes("429")) {
          friendly = "Rate limit reached on the Anthropic API (30,000 input tokens/min on Tier 1). Please wait ~60 seconds and try again, or upgrade your API tier for higher limits.";
        } else if (m.includes("overloaded_error") || m.includes("529")) {
          friendly = "Anthropic is temporarily overloaded. Please try again in a few seconds.";
        } else if (m.includes("invalid_api_key") || m.includes("authentication_error") || m.includes("401")) {
          friendly = "API key is missing or invalid. Set ANTHROPIC_API_KEY in your Vercel environment variables.";
        } else {
          friendly = m;
        }
        setError(friendly);
      }
    finally { clearInterval(iv); setLoading(false); setStage(""); }
  }

  const r = rawReport;
  const exp = fin?.monthlyExpenses || {};
  const upC = (k, v) => setCriteria(p => ({ ...p, [k]: v }));
  const upE = (k, v) => setExpOvr(p => ({ ...p, [k]: v }));
  const rstE = (k) => setExpOvr(p => ({ ...p, [k]: null }));
  const upL = (k, v) => setLoan(p => ({ ...p, [k]: v }));
  const upDscr = (k, v) => setDscrCriteria(p => ({ ...p, [k]: v }));

  const loanKey = `Monthly P&I (${loan.rate}% / ${loan.termYears}yr)`;
  const downKey = `Down (${loan.downPct}%)`;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0f", color: "#fff", fontFamily: "'DM Sans','Helvetica Neue',sans-serif", paddingBottom: 60 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500;600&display=swap');
        *{box-sizing:border-box;margin:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#0a0a0f}::-webkit-scrollbar-thumb{background:#2a2a3a;border-radius:3px}
        input[type=number]::-webkit-inner-spin-button{opacity:0.3}
        input::placeholder{color:rgba(255,255,255,0.2)}input:focus,button:focus{outline:none}
        button{cursor:pointer;transition:opacity 0.15s}button:hover{opacity:0.82}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes slideDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
      `}</style>

      {modal && <DerivationModal data={modal} onClose={() => setModal(null)} />}

      {/* Header */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "18px 28px", display: "flex", alignItems: "center", gap: 14, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(20px)", position: "sticky", top: 0, zIndex: 200 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: "linear-gradient(135deg,#00ff88,#00ccff)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>🏠</div>
        <div>
          <div style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 13, letterSpacing: "0.06em" }}>SFR UNDERWRITER</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 1 }}>Single-Family Rental Analysis Engine</div>
        </div>
        {r && <div style={{ marginLeft: 16, fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace" }}>Click any metric card to see how it was calculated ⓘ</div>}
        <button onClick={() => setPanelOpen(o => !o)} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, background: panelOpen ? "rgba(255,204,0,0.1)" : "rgba(255,255,255,0.05)", border: `1px solid ${panelOpen ? "rgba(255,204,0,0.3)" : "rgba(255,255,255,0.1)"}`, borderRadius: 8, padding: "8px 14px", color: panelOpen ? "#ffcc00" : "rgba(255,255,255,0.6)", fontSize: 12, fontFamily: "'Space Mono',monospace", letterSpacing: "0.04em" }}>
          <span>⚙</span> CRITERIA & EXPENSES {hasOvr && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#ffcc00", flexShrink: 0 }} />}
        </button>
      </div>

      {/* Settings Panel */}
      {panelOpen && (
        <div style={{ animation: "slideDown 0.2s ease", background: "#0d0d14", borderBottom: "1px solid rgba(255,255,255,0.07)", padding: "22px 28px" }}>
          <div style={{ maxWidth: 900, margin: "0 auto" }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
              {[["criteria","📋 Pass/Fail Thresholds"],["expenses","💸 Expense Overrides"],["loan","🏦 Loan Settings"],["dscr","🏷 DSCR Loan Criteria"]].map(([id, lbl]) => (
                <button key={id} onClick={() => setTab(id)} style={{ padding: "7px 15px", borderRadius: 8, fontSize: 12, fontFamily: "'Space Mono',monospace", background: tab === id ? "rgba(0,255,136,0.1)" : "transparent", border: `1px solid ${tab === id ? "rgba(0,255,136,0.3)" : "rgba(255,255,255,0.08)"}`, color: tab === id ? "#00ff88" : "rgba(255,255,255,0.4)" }}>{lbl}</button>
              ))}
            </div>

            {tab === "criteria" && (
              <>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 18, lineHeight: 1.55 }}>Set your minimum/maximum thresholds. The BUY/HOLD/PASS verdict and scorecard update instantly.</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(195px,1fr))", gap: 14 }}>
                  <NumInput label="Min Monthly Cash Flow" value={criteria.minMonthlyCashFlow} onChange={v => upC("minMonthlyCashFlow",v)} prefix="$" step={50} hint="$/mo after all expenses & mortgage" />
                  <NumInput label="Min Cap Rate" value={criteria.minCapRate} onChange={v => upC("minCapRate",v)} suffix="%" step={0.25} hint="NOI ÷ Purchase Price × 100" />
                  <NumInput label="Min Cash-on-Cash" value={criteria.minCashOnCash} onChange={v => upC("minCashOnCash",v)} suffix="%" step={0.25} hint="Annual cash flow ÷ cash invested" />
                  <NumInput label="Min DSCR" value={criteria.minDSCR} onChange={v => upC("minDSCR",v)} step={0.05} hint="NOI ÷ Debt Service (1.25 = standard)" />
                  <NumInput label="Max GRM" value={criteria.maxGRM} onChange={v => upC("maxGRM",v)} step={0.5} hint="Price ÷ Annual Rent (lower = better)" />
                  <NumInput label="Max Break-Even Occ." value={criteria.maxBreakEven} onChange={v => upC("maxBreakEven",v)} suffix="%" step={1} hint="% occupancy needed to cover costs" />
                  <NumInput label="Min 1yr Appreciation" value={criteria.minAppreciation1yr} onChange={v => upC("minAppreciation1yr",v)} suffix="%" step={0.5} hint="Can be negative" />
                  <NumInput label="Max Vacancy Rate" value={criteria.maxVacancyRate} onChange={v => upC("maxVacancyRate",v)} suffix="%" step={1} hint="Market vacancy ceiling" />
                </div>
                {fin && <div style={{ marginTop: 16, padding: "12px 16px", background: "rgba(0,255,136,0.04)", border: "1px solid rgba(0,255,136,0.1)", borderRadius: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace" }}>LIVE:</span>
                  {pf.map(item => <span key={item.label} style={{ fontSize: 10, padding: "3px 10px", borderRadius: 20, background: item.pass ? "rgba(0,255,136,0.1)" : "rgba(255,68,68,0.1)", color: item.pass ? "#00ff88" : "#ff6666", fontFamily: "'Space Mono',monospace" }}>{item.label}: {item.pass ? "✓" : "✗"}</span>)}
                </div>}
                <button onClick={() => setCriteria(DEFAULT_CRITERIA)} style={{ marginTop: 14, fontSize: 11, color: "rgba(255,255,255,0.3)", background: "none", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "6px 14px", fontFamily: "'Space Mono',monospace" }}>↺ Reset to Defaults</button>
              </>
            )}

            {tab === "expenses" && (
              <>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 18, lineHeight: 1.55 }}>Override any expense — all financials recalculate instantly. Yellow = active override. {!r && <span style={{ color: "#ffcc00" }}>Run an analysis first to see AI estimates.</span>}</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(195px,1fr))", gap: 14 }}>
                  {[["taxes","Property Taxes"],["insurance","Insurance"],["maintenance","Maintenance"],["management","Property Mgmt"],["vacancy","Vacancy Reserve"],["capex","CapEx Reserve"],["hoa","HOA"]].map(([key, lbl]) => (
                    <ExpenseRow key={key} label={lbl} origValue={origExp[key]} overrideValue={expOvr[key]} onChange={v => upE(key,v)} onReset={() => rstE(key)} />
                  ))}
                </div>
                {fin && <div style={{ marginTop: 18, padding: "14px 18px", background: "rgba(255,204,0,0.04)", border: "1px solid rgba(255,204,0,0.12)", borderRadius: 10, display: "flex", gap: 24, flexWrap: "wrap" }}>
                  {[["Total Expenses/mo", fmt(exp.total), "#ffcc00"],["Cash Flow/mo", fmt(fin.monthlyCashFlow), fin.monthlyCashFlow >= 0 ? "#00ff88" : "#ff4444"],["Cap Rate", fmtPct(fin.capRate), "#ffcc00"],["Cash-on-Cash", fmtPct(fin.cashOnCash), "#ffcc00"]].map(([l,v,c]) => (
                    <div key={l}><span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", display: "block", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>{l}</span><span style={{ fontSize: 17, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: c }}>{v}</span></div>
                  ))}
                </div>}
                {hasOvr && <button onClick={() => setExpOvr(DEFAULT_EXPENSE_OVERRIDES)} style={{ marginTop: 14, fontSize: 11, color: "#ffcc00", background: "rgba(255,204,0,0.07)", border: "1px solid rgba(255,204,0,0.2)", borderRadius: 6, padding: "6px 14px", fontFamily: "'Space Mono',monospace" }}>↺ Reset All Overrides</button>}
              </>
            )}

            {tab === "loan" && (
              <>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 18, lineHeight: 1.55 }}>Adjust loan assumptions — mortgage, DSCR, and cash flow recalculate instantly.</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(195px,1fr))", gap: 14 }}>
                  <NumInput label="Down Payment" value={loan.downPct} onChange={v => upL("downPct",v)} suffix="%" step={5} min={0} hint="% of purchase price" />
                  <NumInput label="Interest Rate" value={loan.rate} onChange={v => upL("rate",v)} suffix="%" step={0.125} min={0} hint="Annual rate" />
                  <NumInput label="Loan Term" value={loan.termYears} onChange={v => upL("termYears",v)} suffix="yrs" step={5} min={5} hint="15 or 30 yrs most common" />
                </div>
                {fin && r && <div style={{ marginTop: 18, padding: "14px 18px", background: "rgba(0,204,255,0.04)", border: "1px solid rgba(0,204,255,0.12)", borderRadius: 10, display: "flex", gap: 24, flexWrap: "wrap" }}>
                  {[["Loan Amount", fmt(fin.loanAmount), "#00ccff"],["Monthly P&I", fmt(fin.monthlyMortgage), "#00ccff"],["Cash Flow/mo", fmt(fin.monthlyCashFlow), fin.monthlyCashFlow >= 0 ? "#00ff88" : "#ff4444"],["DSCR", fin.dscr?.toFixed(2), fin.dscr >= 1.25 ? "#00ff88" : "#ff8844"]].map(([l,v,c]) => (
                    <div key={l}><span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", display: "block", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>{l}</span><span style={{ fontSize: 17, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: c }}>{v}</span></div>
                  ))}
                </div>}
                <button onClick={() => setLoan(DEFAULT_LOAN)} style={{ marginTop: 14, fontSize: 11, color: "rgba(255,255,255,0.3)", background: "none", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "6px 14px", fontFamily: "'Space Mono',monospace" }}>↺ Reset (25% / 7.5% / 30yr)</button>
              </>
            )}

            {tab === "dscr" && (
              <>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 18, lineHeight: 1.55 }}>
                  Adjust the thresholds for each DSCR lender tier. <strong style={{ color: "rgba(255,255,255,0.55)" }}>Lender DSCR = Gross Rent ÷ PITIA</strong> (P&I + Taxes + Insurance + HOA) — lenders exclude management, maintenance, vacancy & CapEx. Rate premiums are relative to the conventional benchmark rate.
                </p>
                <div style={{ fontSize: 11, color: "#00ccff", fontFamily: "'Space Mono',monospace", letterSpacing: "0.1em", marginBottom: 10 }}>LENDER TIERS</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 22 }}>
                  {[
                    { label: "Tier A — Premium", minKey: "tier1MinDscr", ltvKey: "tier1MaxLtv", rateKey: "ratePremiumTier1", col: "#00ff88" },
                    { label: "Tier B — Standard", minKey: "tier2MinDscr", ltvKey: "tier2MaxLtv", rateKey: "ratePremiumTier2", col: "#ffcc00" },
                    { label: "Tier C — No-Ratio", minKey: "tier3MinDscr", ltvKey: "tier3MaxLtv", rateKey: "ratePremiumTier3", col: "#ff8844" },
                  ].map(({ label, minKey, ltvKey, rateKey, col }) => (
                    <div key={label} style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${col}22`, borderRadius: 10, padding: "14px" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: col, fontFamily: "'Space Mono',monospace", marginBottom: 12 }}>{label}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <NumInput label="Min DSCR" value={dscrCriteria[minKey]} onChange={v => upDscr(minKey, v)} step={0.05} hint="Gross Rent ÷ PITIA" />
                        <NumInput label="Max LTV" value={dscrCriteria[ltvKey]} onChange={v => upDscr(ltvKey, v)} suffix="%" step={5} hint="Loan ÷ Property Value" />
                        <NumInput label="Rate Premium" value={dscrCriteria[rateKey]} onChange={v => upDscr(rateKey, v)} suffix="%" step={0.125} hint="Above conventional benchmark" />
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.1em", marginBottom: 10 }}>UNIVERSAL REQUIREMENTS</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(175px,1fr))", gap: 12, marginBottom: 16 }}>
                  <NumInput label="Min Property Value" value={dscrCriteria.minPropertyValue} onChange={v => upDscr("minPropertyValue", v)} prefix="$" step={10000} hint="Most lenders: $75K–$150K" />
                  <NumInput label="Min Loan Amount" value={dscrCriteria.minLoanAmount} onChange={v => upDscr("minLoanAmount", v)} prefix="$" step={5000} hint="Most lenders: $75K" />
                  <NumInput label="Reserves (months)" value={dscrCriteria.reservesMonths} onChange={v => upDscr("reservesMonths", v)} suffix="mo" step={1} min={0} hint="Months of PITIA at closing" />
                  <NumInput label="Conventional Rate" value={dscrCriteria.conventionalRate} onChange={v => upDscr("conventionalRate", v)} suffix="%" step={0.125} hint="30yr benchmark for rate comparison" />
                </div>
                {dscrQual && (
                  <div style={{ padding: "12px 16px", background: "rgba(0,204,255,0.05)", border: "1px solid rgba(0,204,255,0.15)", borderRadius: 10, display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace" }}>LIVE:</span>
                    <div><span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", display: "block" }}>Lender DSCR</span><span style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#00ccff" }}>{dscrQual.lenderDscr.toFixed(2)}x</span></div>
                    <div><span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", display: "block" }}>PITIA</span><span style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: "#fff" }}>{fmt(dscrQual.pitia)}</span></div>
                    <div><span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", display: "block" }}>Qualifies</span><span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: dscrQual.highestTier ? "#00ff88" : "#ff4444" }}>{dscrQual.highestTier ? dscrQual.highestTier.label : "No Tier"}</span></div>
                  </div>
                )}
                <button onClick={() => setDscrCriteria(DEFAULT_DSCR_CRITERIA)} style={{ marginTop: 14, fontSize: 11, color: "rgba(255,255,255,0.3)", background: "none", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "6px 14px", fontFamily: "'Space Mono',monospace" }}>↺ Reset DSCR Criteria to Defaults</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Main */}
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 24px" }}>
        {/* Input */}
        <div style={{ padding: "40px 0 28px", textAlign: "center" }}>
          {!r && <>
            <div style={{ fontSize: 11, color: "#00ff88", fontFamily: "'Space Mono',monospace", letterSpacing: "0.2em", marginBottom: 12 }}>PROFESSIONAL UNDERWRITING · INSTANT ANALYSIS</div>
            <h1 style={{ fontSize: "clamp(24px,5vw,40px)", fontWeight: 300, lineHeight: 1.15, margin: "0 0 10px", letterSpacing: "-0.02em" }}>Underwrite any<br /><span style={{ fontWeight: 700, color: "#00ff88" }}>rental property</span> in seconds</h1>
            <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 14, marginBottom: 28 }}>Paste an address or Zillow link — we pull live data and run the full numbers</p>
          </>}
          <div style={{ display: "flex", maxWidth: 640, margin: "0 auto", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !loading && runUnderwriting()}
              placeholder="123 Main St, Austin TX  —or—  zillow.com/homedetails/..."
              style={{ flex: 1, background: "transparent", border: "none", padding: "18px 20px", fontSize: 14, color: "#fff", fontFamily: "'DM Sans',sans-serif" }} />
            <button onClick={runUnderwriting} disabled={loading || !input.trim()} style={{ background: loading ? "rgba(0,255,136,0.2)" : "linear-gradient(135deg,#00ff88,#00e077)", border: "none", padding: "0 24px", fontSize: 12, fontWeight: 700, color: "#000", fontFamily: "'Space Mono',monospace", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
              {loading ? <span style={{ animation: "pulse 1s infinite" }}>ANALYZING</span> : "UNDERWRITE →"}
            </button>
          </div>
          {loading && <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(0,255,136,0.25)", borderTop: "2px solid #00ff88", animation: "spin 0.8s linear infinite" }} />
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontFamily: "'Space Mono',monospace" }}>{stage}</span>
          </div>}
          {error && <div style={{ marginTop: 16, padding: "12px 18px", background: "rgba(255,68,68,0.1)", border: "1px solid rgba(255,68,68,0.2)", borderRadius: 10, fontSize: 13, color: "#ff8888", maxWidth: 640, margin: "16px auto 0", textAlign: "left" }}>{error}</div>}
        </div>

        {/* Report */}
        {r && fin && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            {/* Banner */}
            <div style={{ background: "linear-gradient(135deg,rgba(0,255,136,0.07),rgba(0,204,255,0.04))", border: "1px solid rgba(0,255,136,0.14)", borderRadius: 16, padding: "20px 24px", marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#00ff88", fontFamily: "'Space Mono',monospace", letterSpacing: "0.1em", marginBottom: 4 }}>SUBJECT PROPERTY</div>
                  <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>{r.property?.address}</div>
                  <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, marginTop: 3 }}>{r.property?.city}, {r.property?.state} {r.property?.zip} · {r.property?.beds}bd/{r.property?.baths}ba · {r.property?.sqft?.toLocaleString()} sqft · Built {r.property?.yearBuilt}</div>
                </div>
                <ScoreMeter passFail={pf} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                {[
                  { label: "Asking Price",   value: r.valuation?.listPrice == null ? "Re-run analysis" : r.valuation.listPrice > 0 ? fmt(r.valuation.listPrice) : (r.market?.daysOnMarket > 0 && r.valuation?.estimatedValue > 0) ? `~${fmt(r.valuation.estimatedValue)}` : (r.market?.daysOnMarket > 0 ? "Listed — re-run" : "Off-market"),  color: r.valuation?.listPrice > 0 ? "#00ff88" : (r.market?.daysOnMarket > 0 ? "#ff8844" : "#00ff88") },
                  { label: "Days on Market", value: r.market?.daysOnMarket > 0 ? `${r.market.daysOnMarket} days` : "—",                                                color: "#00ccff" },
                  { label: "Property Taxes", value: fin?.monthlyExpenses?.taxes > 0     ? `${fmt(fin.monthlyExpenses.taxes * 12)}/yr`     : "N/A",                     color: "#ffcc00" },
                  { label: "HOA",            value: fin?.monthlyExpenses?.hoa > 0       ? `${fmt(fin.monthlyExpenses.hoa)}/mo`            : "None",                    color: "#bb88ff" },
                  { label: "Est. Insurance", value: fin?.monthlyExpenses?.insurance > 0 ? `${fmt(fin.monthlyExpenses.insurance * 12)}/yr` : "N/A",                     color: "#ff8844" },
                ].map(s => (
                  <div key={s.label}>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.06em", marginBottom: 3 }}>{s.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: s.color }}>{s.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Summary */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 18px", marginBottom: 22, fontSize: 14, color: "rgba(255,255,255,0.7)", lineHeight: 1.6 }}>
              <span style={{ color: "#fff", fontWeight: 600 }}>AI Summary: </span>{r.rating?.summary}
            </div>

            {/* Scorecard */}
            <Section title="Underwriting Scorecard" accent="#ffcc00">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 8, marginBottom: 8 }}>
                {pf.map(item => (
                  <div key={item.label}
                    onClick={() => showD(item.label)}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 14px", borderRadius: 10, background: item.pass ? "rgba(0,255,136,0.05)" : "rgba(255,68,68,0.06)", border: `1px solid ${item.pass ? "rgba(0,255,136,0.18)" : "rgba(255,68,68,0.22)"}`, cursor: derivations[item.label] ? "pointer" : "default", transition: "background 0.15s" }}
                    onMouseEnter={e => { if (derivations[item.label]) e.currentTarget.style.background = item.pass ? "rgba(0,255,136,0.09)" : "rgba(255,68,68,0.1)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = item.pass ? "rgba(0,255,136,0.05)" : "rgba(255,68,68,0.06)"; }}
                    title="Click to see derivation"
                  >
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: item.pass ? "#00ff88" : "#ff6666", display: "flex", alignItems: "center", gap: 5 }}>{item.label} <span style={{ fontSize: 9, color: "rgba(255,255,255,0.2)" }}>ⓘ</span></div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 2, fontFamily: "'Space Mono',monospace" }}>threshold: {item.threshold}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: item.pass ? "#00ff88" : "#ff6666" }}>{item.value}</div>
                      <div style={{ fontSize: 10, color: item.pass ? "#00ff88" : "#ff4444", marginTop: 1 }}>{item.pass ? "✓ PASS" : "✗ FAIL"}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.22)", fontFamily: "'Space Mono',monospace" }}>{passCount}/{pf.length} criteria met · click any card to see derivation · adjust thresholds in ⚙ above</div>
            </Section>

            {/* Max Purchase Price by Test */}
            {maxPrices && (
              <Section title="Max Purchase Price by Test" accent="#00ccff">
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.38)", marginBottom: 14, lineHeight: 1.55 }}>
                  The highest purchase price at which each criterion still passes — holding rent, expenses, down %, rate, and term constant. Updates live as you adjust criteria or loan settings.
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
                  {maxPrices.map(m => {
                    const impossible = m.maxPrice === null;
                    const delta = impossible ? null : m.maxPrice - fin.purchasePrice;
                    const above = delta !== null && delta >= 0;
                    const bg = impossible ? "rgba(255,68,68,0.05)" : above ? "rgba(0,255,136,0.05)" : "rgba(255,204,0,0.05)";
                    const bd = impossible ? "rgba(255,68,68,0.18)" : above ? "rgba(0,255,136,0.18)" : "rgba(255,204,0,0.18)";
                    const lc = impossible ? "#ff6666" : above ? "#00ff88" : "#ffcc00";
                    return (
                      <div key={m.label} style={{ padding: "12px 14px", borderRadius: 10, background: bg, border: `1px solid ${bd}` }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: lc, marginBottom: 2 }}>{m.label}</div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", marginBottom: 8 }}>threshold: {m.threshold}</div>
                        <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: impossible ? "#ff6666" : "#fff" }}>
                          {impossible ? "— impossible —" : fmt(m.maxPrice)}
                        </div>
                        {!impossible && (
                          <div style={{ fontSize: 10, color: above ? "#00ff88" : "#ffcc00", fontFamily: "'Space Mono',monospace", marginTop: 3 }}>
                            {above ? "+" : ""}{fmt(delta)} vs asking
                          </div>
                        )}
                        {impossible && (
                          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
                            rent/expenses can't satisfy this criterion at any price
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.22)", fontFamily: "'Space Mono',monospace", marginTop: 10 }}>
                  1yr Appreciation & Vacancy Rate are market-data tests — not price-dependent, so no max price is shown.
                </div>
              </Section>
            )}

            {/* DSCR Loan Qualification */}
            <DSCRLoanSection qual={dscrQual} onShowDerivation={setModal} />

            {/* Key Metrics */}
            <Section title="Key Financials">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(148px,1fr))", gap: 10 }}>
                <MetricCard label="Est. Value"    value={fmt(r.valuation?.estimatedValue)} derivation={derivations["AVM Value"]} onShowDerivation={setModal} />
                <MetricCard label="Monthly Rent"  value={fmt(fin.monthlyRent)} color="#00ccff" derivation={derivations["Monthly Rent"]} onShowDerivation={setModal} />
                <MetricCard label="Cash Flow/mo"  value={fmt(fin.monthlyCashFlow)} color={fin.monthlyCashFlow >= criteria.minMonthlyCashFlow ? "#00ff88" : "#ff4444"} showPass pass={fin.monthlyCashFlow >= criteria.minMonthlyCashFlow} derivation={derivations["Cash Flow/mo"]} onShowDerivation={setModal} />
                <MetricCard label="Cap Rate"      value={fmtPct(fin.capRate)} color="#ffcc00" showPass pass={fin.capRate >= criteria.minCapRate} derivation={derivations["Cap Rate"]} onShowDerivation={setModal} />
                <MetricCard label="Cash-on-Cash"  value={fmtPct(fin.cashOnCash)} color="#ffcc00" showPass pass={fin.cashOnCash >= criteria.minCashOnCash} derivation={derivations["Cash-on-Cash"]} onShowDerivation={setModal} />
                <MetricCard label="DSCR"          value={fin.dscr?.toFixed(2)} color={fin.dscr >= criteria.minDSCR ? "#00ff88" : "#ff8844"} showPass pass={fin.dscr >= criteria.minDSCR} derivation={derivations["DSCR"]} onShowDerivation={setModal} />
                <MetricCard label="GRM"           value={fin.grm?.toFixed(1)} color="#bb88ff" showPass pass={fin.grm <= criteria.maxGRM} derivation={derivations["GRM"]} onShowDerivation={setModal} />
                <MetricCard label="Break-Even"    value={fmtPct(fin.breakEvenOccupancy)} color="#ff8844" showPass pass={fin.breakEvenOccupancy <= criteria.maxBreakEven} derivation={derivations["Break-Even"]} onShowDerivation={setModal} />
              </div>
            </Section>

            {/* Detailed Financials */}
            <Section title="Detailed Financials">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 20 }}>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.1em", marginBottom: 14 }}>DEAL STRUCTURE</div>
                  <ClickableRow label="Purchase Price"  value={fmt(fin.purchasePrice)}   derivation={derivations["Purchase Price"]}  onShowDerivation={setModal} />
                  <ClickableRow label={downKey}         value={fmt(fin.downPayment)}      derivation={derivations[downKey]}           onShowDerivation={setModal} />
                  <ClickableRow label="Loan Amount"     value={fmt(fin.loanAmount)}       derivation={derivations["Loan Amount"]}     onShowDerivation={setModal} />
                  <ClickableRow label={loanKey}         value={fmt(fin.monthlyMortgage)}  derivation={derivations[loanKey]}           onShowDerivation={setModal} />
                  <ClickableRow label="Gross Monthly Rent" value={fmt(fin.monthlyRent)}  derivation={derivations["Gross Monthly Rent"]} onShowDerivation={setModal} />
                  <ClickableRow label="Annual NOI"      value={fmt(fin.annualNOI)}        derivation={derivations["Annual NOI"]}      onShowDerivation={setModal} />
                  <ClickableRow label="Annual Cash Flow" value={fmt(fin.annualCashFlow)} color={fin.annualCashFlow >= 0 ? "#00ff88" : "#ff4444"} derivation={derivations["Annual Cash Flow"]} onShowDerivation={setModal} />
                </div>
                <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", letterSpacing: "0.1em" }}>MONTHLY EXPENSES</div>
                    {hasOvr && <span style={{ fontSize: 10, color: "#ffcc00", fontFamily: "'Space Mono',monospace" }}>OVERRIDES ACTIVE ✎</span>}
                  </div>
                  {[["taxes","Property Taxes"],["insurance","Insurance"],["maintenance","Maintenance"],["management","Property Mgmt"],["vacancy","Vacancy Reserve"],["capex","CapEx Reserve"],["hoa","HOA"]].map(([key, lbl]) => {
                    const isO = expOvr[key] !== null && expOvr[key] !== undefined;
                    return <ClickableRow key={key} label={lbl} value={fmt(exp[key])} isOvr={isO} derivation={derivations[lbl]} onShowDerivation={setModal} />;
                  })}
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 0 0", fontSize: 14, cursor: "pointer" }}
                    onClick={() => showD("TOTAL")} title="Click to see derivation">
                    <span style={{ color: "#ffcc00", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>TOTAL <span style={{ fontSize: 9, color: "rgba(255,255,255,0.2)" }}>ⓘ</span></span>
                    <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, color: "#ffcc00" }}>{fmt(exp.total)}</span>
                  </div>
                </div>
              </div>
            </Section>

            {/* Valuation & Rental */}
            <Section title="Valuation & Rental Market">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(148px,1fr))", gap: 10 }}>
                <MetricCard label="AVM Value"    value={fmt(r.valuation?.estimatedValue)} derivation={derivations["AVM Value"]} onShowDerivation={setModal} />
                <MetricCard label="Price/SqFt"   value={fmt(r.valuation?.pricePerSqft)} derivation={derivations["Price/SqFt"]} onShowDerivation={setModal} />
                <MetricCard label="Last Sale"     value={fmt(r.valuation?.lastSalePrice)} sub={r.valuation?.lastSaleDate} derivation={derivations["Last Sale"]} onShowDerivation={setModal} />
                <MetricCard label="Est. Rent"     value={fmt(r.rental?.estimatedMonthlyRent)} color="#00ccff" derivation={derivations["Est. Rent"]} onShowDerivation={setModal} />
                <MetricCard label="Rent/SqFt"     value={fmt(r.rental?.rentPerSqft,"$",2)} color="#00ccff" derivation={derivations["Rent/SqFt"]} onShowDerivation={setModal} />
                <MetricCard label="Vacancy Rate"  value={fmtPct(r.rental?.vacancyRate)} color="#ff8844" showPass pass={(r.rental?.vacancyRate??0) <= criteria.maxVacancyRate} derivation={derivations["Vacancy Rate"]} onShowDerivation={setModal} />
                <MetricCard label="Rent Range"    value={`${fmt(r.rental?.rentRange?.low)}–${fmt(r.rental?.rentRange?.high)}`} color="#00ccff" derivation={derivations["Rent Range"]} onShowDerivation={setModal} />
                <MetricCard label="Days to Rent"  value={`${r.rental?.averageDaysToRent || "N/A"}`} sub="days" derivation={derivations["Days to Rent"]} onShowDerivation={setModal} />
              </div>
            </Section>

            {/* Market */}
            <Section title="Market Trends">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(148px,1fr))", gap: 10 }}>
                <MetricCard label="1yr Appreciation" value={fmtPct(r.market?.appreciation1yr)} color={r.market?.appreciation1yr >= 0 ? "#00ff88" : "#ff4444"} showPass pass={(r.market?.appreciation1yr??0) >= criteria.minAppreciation1yr} derivation={derivations["1yr Appreciation"]} onShowDerivation={setModal} />
                <MetricCard label="3yr Appreciation" value={fmtPct(r.market?.appreciation3yr)} color={r.market?.appreciation3yr >= 0 ? "#00ff88" : "#ff4444"} derivation={derivations["3yr Appreciation"]} onShowDerivation={setModal} />
                <MetricCard label="5yr Appreciation" value={fmtPct(r.market?.appreciation5yr)} color={r.market?.appreciation5yr >= 0 ? "#00ff88" : "#ff4444"} derivation={derivations["5yr Appreciation"]} onShowDerivation={setModal} />
                <MetricCard label="Rent Growth 1yr"  value={fmtPct(r.market?.rentGrowth1yr)} color="#00ccff" derivation={derivations["Rent Growth 1yr"]} onShowDerivation={setModal} />
                <MetricCard label="Days on Market"   value={`${r.market?.daysOnMarket || "N/A"}`} sub="days" derivation={derivations["Days on Market"]} onShowDerivation={setModal} />
                <MetricCard label="Market Trend"     value={r.market?.marketTrend || "N/A"} color="#bb88ff" derivation={derivations["Market Trend"]} onShowDerivation={setModal} />
              </div>
            </Section>

            {/* Neighborhood */}
            <Section title="Neighborhood & Location">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(148px,1fr))", gap: 10 }}>
                <MetricCard label="Walk Score"       value={`${r.neighborhood?.walkScore || "N/A"}`} sub="/100" color="#00ff88" derivation={derivations["Walk Score"]} onShowDerivation={setModal} />
                <MetricCard label="Transit Score"    value={`${r.neighborhood?.transitScore || "N/A"}`} sub="/100" derivation={derivations["Transit Score"]} onShowDerivation={setModal} />
                <MetricCard label="School Rating"    value={`${r.neighborhood?.schoolRating || "N/A"}`} sub="/10" color="#ffcc00" derivation={derivations["School Rating"]} onShowDerivation={setModal} />
                <MetricCard label="Crime Index"      value={r.neighborhood?.crimeIndex || "N/A"} color={r.neighborhood?.crimeIndex?.toLowerCase()?.includes("low") ? "#00ff88" : "#ff8844"} derivation={derivations["Crime Index"]} onShowDerivation={setModal} />
                <MetricCard label="Flood Zone"       value={r.neighborhood?.floodZone || "N/A"} color={r.neighborhood?.floodZone?.includes("X") ? "#00ff88" : "#ff8844"} derivation={derivations["Flood Zone"]} onShowDerivation={setModal} />
                <MetricCard label="Median HH Income" value={fmt(r.neighborhood?.medianHouseholdIncome)} derivation={derivations["Median HH Income"]} onShowDerivation={setModal} />
              </div>
            </Section>

            {/* Risks & Opps */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 28 }}>
              <Section title="Risks">
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {(r.risks || []).map((risk, i) => <div key={i} style={{ padding: "10px 14px", background: "rgba(255,68,68,0.06)", border: "1px solid rgba(255,68,68,0.14)", borderRadius: 8, fontSize: 13, color: "rgba(255,255,255,0.72)", lineHeight: 1.5, display: "flex", gap: 10 }}><span style={{ color: "#ff6666", flexShrink: 0 }}>▲</span>{risk}</div>)}
                </div>
              </Section>
              <Section title="Opportunities">
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {(r.opportunities || []).map((opp, i) => <div key={i} style={{ padding: "10px 14px", background: "rgba(0,255,136,0.05)", border: "1px solid rgba(0,255,136,0.12)", borderRadius: 8, fontSize: 13, color: "rgba(255,255,255,0.72)", lineHeight: 1.5, display: "flex", gap: 10 }}><span style={{ color: "#00ff88", flexShrink: 0 }}>★</span>{opp}</div>)}
                </div>
              </Section>
            </div>

            {/* Footer */}
            <div style={{ padding: "14px 18px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10, fontSize: 11, color: "rgba(255,255,255,0.25)", lineHeight: 1.6 }}>
              <strong style={{ color: "rgba(255,255,255,0.38)" }}>Data Sources:</strong> {(r.dataSources || []).join(", ") || "Zillow, Rentometer, Walk Score, public records"}<br />
              <strong style={{ color: "rgba(255,255,255,0.38)" }}>Analysis Date:</strong> {r.analysisDate || new Date().toLocaleDateString()}<br />
              {r.disclaimer || "For informational purposes only. Not financial or investment advice. Verify all data independently before making investment decisions."}
            </div>
            <div style={{ textAlign: "center", marginTop: 24 }}>
              <button onClick={() => { setRawReport(null); setInput(""); setExpOvr(DEFAULT_EXPENSE_OVERRIDES); setModal(null); setTimeout(() => inputRef.current?.focus(), 100); }} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.5)", padding: "10px 22px", borderRadius: 8, fontSize: 12, fontFamily: "'Space Mono',monospace", letterSpacing: "0.05em" }}>← ANALYZE ANOTHER PROPERTY</button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!r && !loading && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 12, marginTop: 8 }}>
            {[{icon:"🔍",label:"Live Web Research",desc:"Pulls real data from Zillow, Rentometer, county records & more"},{icon:"📋",label:"Custom Pass/Fail",desc:"Set your own thresholds for cap rate, cash flow, DSCR & more"},{icon:"🏷",label:"DSCR Loan Qualification",desc:"3-tier lender pass/fail with PITIA breakdown & rate estimates"},{icon:"ⓘ",label:"Derivation Modals",desc:"Click any data field to see the exact formula with real numbers"}].map(f => (
              <div key={f.label} style={{ padding: "18px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12 }}>
                <div style={{ fontSize: 22, marginBottom: 8 }}>{f.icon}</div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{f.label}</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>{f.desc}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
