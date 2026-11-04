// Referral Revenue Calculator: the formulas, shared word for word by the page and the server.
// Presets come from published benchmarks (see the page for sources). Cautious uses the low end.
const REF_PRESETS = {
  cautious: { refer: 2, signup: 5, convert: 5, uplift: 0, churn_cut: 0 },
  typical: { refer: 5, signup: 15, convert: 8, uplift: 25, churn_cut: 18 },
  strong: { refer: 10, signup: 25, convert: 12, uplift: 50, churn_cut: 18 }
};
const REF_RAMP_MONTHS = 6;   // the programme builds to full strength over six months
const REF_SALES_LAG = 3;     // sales-led deals close about three months after sign-up
const REF_MAX_LIFE = 10;     // cap customer lifetime at ten years

// Improve a rate by 5 points, or by 1 point when it is under 10%.
const refStep = (rate) => (rate < 10 ? 1 : 5);

function refRates(i) {
  const p = REF_PRESETS[i.preset] || REF_PRESETS.typical;
  const convert = i.motion === 'sales_led' ? Math.min(100, i.win_rate * (1 + p.uplift / 100)) : p.convert;
  return { refer: p.refer, signup: p.signup, convert, churn_cut: p.churn_cut, uplift: p.uplift };
}

// Run twelve months. Referred customers join the base and can refer others too.
function refRun(i, rates) {
  const lag = i.motion === 'sales_led' ? REF_SALES_LAG : 0;
  const closing = new Array(12 + lag).fill(0);
  let won = 0;
  let referrers = 0;
  let signups = 0;
  const monthly = [];
  for (let m = 1; m <= 12; m++) {
    const ramp = Math.min(1, m / REF_RAMP_MONTHS);
    const r = (i.customers + won) * (rates.refer / 100) * ramp;
    const s = r * (rates.signup / 100);
    referrers += r;
    signups += s;
    closing[m - 1 + lag] += s * (rates.convert / 100);
    won += closing[m - 1];
    monthly.push(+closing[m - 1].toFixed(2));
  }
  const later = closing.slice(12).reduce((a, b) => a + b, 0);
  return { referrers, signups, won, later, monthly };
}

function refMaths(i) {
  const r0 = (x) => Math.round(x);
  const r1 = (x) => Math.round(x * 10) / 10;
  const rates = refRates(i);
  const run = refRun(i, rates);
  const n = run.won;
  const rewardCost = n * i.reward;
  const runningCost = 12 * i.monthly_cost;
  const totalCost = rewardCost + runningCost;
  const costPer = n > 0 ? totalCost / n : null;
  const life = (churn) => Math.min(REF_MAX_LIFE, 100 / Math.max(churn, 0.1));
  const lifeNormal = life(i.churn);
  const lifeReferred = life(i.churn * (1 - rates.churn_cut / 100));

  // What-if: improve one lever at a time and see the extra customers in a year.
  const levers = [
    ['refer', 'Customers who refer each month'],
    ['signup', 'Referred people who sign up'],
    i.motion === 'sales_led' ? ['win_rate', 'Your win rate'] : ['convert', 'Sign-ups who become paying']
  ];
  const whatIf = levers.map(([key, label]) => {
    const from = key === 'win_rate' ? i.win_rate : rates[key];
    const to = Math.min(100, from + refStep(from));
    let better;
    if (key === 'win_rate') better = { ...rates, convert: Math.min(100, to * (1 + rates.uplift / 100)) };
    else better = { ...rates, [key]: to };
    const extra = refRun(i, better).won - n;
    return { lever: label, from, to, extra_customers: r1(extra), extra_arr: r0(extra * i.acv) };
  }).sort((a, b) => b.extra_arr - a.extra_arr);

  const warnings = [];
  if (n < 1) warnings.push('At these numbers, referrals would bring in fewer than one new customer in a year.');
  if (i.reward > i.acv * 0.2) warnings.push('The reward is more than 20% of a customer\'s first-year value, which is above the usual range of 5% to 20%.');
  if (i.reward >= i.paid_cac) warnings.push('The reward costs as much as winning a customer through paid channels, so it removes most of the saving.');
  if (costPer !== null && costPer >= i.paid_cac) warnings.push('Once running costs are included, referrals cost more per customer than paid channels at these numbers.');

  return {
    rates: { refer: rates.refer, signup: rates.signup, convert: r1(rates.convert), churn_cut: rates.churn_cut },
    referrers: r0(run.referrers),
    signups: r1(run.signups),
    new_customers: r1(n),
    still_in_pipeline: r1(run.later),
    arr_added: r0(n * i.acv),
    share_of_base_pct: r1((n / i.customers) * 100),
    reward_cost: r0(rewardCost),
    running_cost: r0(runningCost),
    total_cost: r0(totalCost),
    cost_per_customer: costPer === null ? null : r0(costPer),
    paid_cost_same_customers: r0(n * i.paid_cac),
    saving_vs_paid: r0(n * i.paid_cac - totalCost),
    payback_months: costPer === null ? null : r1(costPer / (i.acv / 12)),
    reward_pct_of_acv: r1((i.reward / i.acv) * 100),
    lifetime_years_normal: r1(lifeNormal),
    lifetime_years_referred: r1(lifeReferred),
    lifetime_value_normal: r0(i.acv * lifeNormal),
    lifetime_value_referred: r0(i.acv * lifeReferred),
    monthly_new_customers: run.monthly,
    what_if: whatIf,
    warnings
  };
}
