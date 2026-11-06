// Expansion Route Planner: the formulas, shared word for word by the page and the server.
// Cost presets are planning estimates within published ranges; users can change them.
const ROUTE_TIERS = {
  simpler: { label: 'Simpler', examples: 'for example UK, Netherlands, Singapore', setup: 6000, running: 1200, setup_months: 2.5 },
  complex: { label: 'More complex', examples: 'for example Germany, France', setup: 15000, running: 2500, setup_months: 3.5 },
  most: { label: 'Most complex', examples: 'for example Brazil, India', setup: 20000, running: 3500, setup_months: 5 }
};
const ROUTE_FX = { GBP: 1, USD: 1.27, EUR: 1.17 };      // rough rates for prefilling only
const ROUTE_FEE_GBP = 475;                              // about $599, the common published starting fee
const ROUTE_PAYROLL_GBP = 40;                           // payroll per person a month on your own company
const ROUTE_LANGUAGE_UPLIFT = 1.3;                      // running cost uplift when you do not speak the local language
const ROUTE_MONTHS = 24;
const ROUTE_URGENCY_MONTHS = { month: 1, soon: 3, later: 99 };

// Headcount each month, in a straight line from now to 12 months to 24 months.
function routeHeadcount(i) {
  const out = [];
  for (let m = 1; m <= ROUTE_MONTHS; m++) {
    const h = m <= 12 ? i.now + (i.m12 - i.now) * (m / 12) : i.m12 + (i.m24 - i.m12) * ((m - 12) / 12);
    out.push(Math.max(0, Math.round(h)));
  }
  return out;
}

function routeMaths(i) {
  const r0 = (x) => Math.round(x);
  const tier = ROUTE_TIERS[i.tier] || ROUTE_TIERS.complex;
  const heads = routeHeadcount(i);
  const running = i.running * (i.local_language ? 1 : ROUTE_LANGUAGE_UPLIFT);
  const eorMonth = (h) => h * i.fee;
  const ownMonth = (h) => running + h * i.payroll;
  const setupMonths = Math.ceil(tier.setup_months);
  const readyMonth = setupMonths + 1;              // earliest month your own company can employ people

  // Month by month, when does your own company become cheaper to run than employer of record?
  let switchMonth = null;
  for (let m = 1; m <= ROUTE_MONTHS; m++) if (eorMonth(heads[m - 1]) >= ownMonth(heads[m - 1]) && heads[m - 1] > 0) { switchMonth = m; break; }
  const crossHead = i.fee > i.payroll ? Math.ceil(running / (i.fee - i.payroll)) : null;

  // Cost of a plan that uses employer of record until a given month, then your own company.
  const planCost = (sw) => {
    const cum = [];
    let t = 0;
    for (let m = 1; m <= ROUTE_MONTHS; m++) {
      if (sw !== null && m === Math.max(1, sw - setupMonths)) t += i.setup;
      t += sw !== null && m >= sw ? ownMonth(heads[m - 1]) : eorMonth(heads[m - 1]);
      cum.push(r0(t));
    }
    return cum;
  };
  const stayEor = planCost(null);
  const financialSwitch = switchMonth === null ? null : Math.max(switchMonth, readyMonth);
  const financialPlan = financialSwitch === null ? null : planCost(financialSwitch);
  const financial = financialPlan !== null && financialPlan[ROUTE_MONTHS - 1] < stayEor[ROUTE_MONTHS - 1];

  const risk = !!(i.risk_sales || i.risk_manager || i.risk_licences || i.risk_regulated);
  const strategic = !!(i.plan_permanent || i.ma);
  const score = [financial, risk, strategic].filter(Boolean).length;

  // Pick the plan.
  let route, sw = null;
  if (score >= 2) {
    route = 'own';
    sw = risk ? readyMonth : (financial ? financialSwitch : readyMonth);
  } else {
    route = 'eor';
  }
  const plan = route === 'own' ? planCost(sw) : stayEor;
  const setupStart = sw === null ? null : Math.max(1, sw - setupMonths);
  const needBy = ROUTE_URGENCY_MONTHS[i.urgency] || 3;
  const bridge = route === 'own' && (heads[0] > 0 || needBy < readyMonth);

  const steps = [];
  if (route === 'own') {
    if (setupStart === 1) steps.push('Start setting up your own company now. It takes about ' + tier.setup_months + ' months in this type of country.');
    else steps.push('Start setting up your own company in month ' + setupStart + ', about ' + tier.setup_months + ' months before you need it.');
    if (bridge || sw > 1) steps.push('Use employer of record for your first hires' + (sw > 1 ? ' until month ' + sw : '') + ', so you can hire straight away.');
    steps.push('Move your team onto your own company in month ' + sw + '.');
  } else {
    steps.push('Hire through employer of record. You can start within days or weeks, with no setup cost.');
    if (switchMonth !== null) steps.push('Review the decision in month ' + Math.max(1, switchMonth - setupMonths) + '. Your own company starts to cost less to run at about ' + (crossHead || heads[switchMonth - 1]) + ' people, around month ' + switchMonth + '.');
    else steps.push('At this hiring plan, your own company does not become cheaper within 24 months. Review the decision if your plans grow.');
  }

  const flags = [];
  if (i.risk_sales || i.risk_manager) flags.push('Staff who sign contracts, close local sales or run the local operation can create a taxable presence in that country, even through employer of record. Get tax advice for that country before they start.');
  if (i.risk_licences) flags.push('Local licences, contracts in your own name, public tenders or local data storage usually need your own local company.');
  if (i.risk_regulated) flags.push('Regulated sectors often need a local company from the start. Check the rules for that country early.');
  if (i.ma) flags.push('Acquisitions and carve-outs come with fixed deadlines, so plan payroll and employment transfers in parallel with the deal.');
  if (i.exclusive) flags.push('People who work only for you, full-time and under your direction, are usually treated as employees. Using contractors for them is risky, so employer of record is the safer first step.');
  if (!i.local_language) flags.push('Running a company where you do not speak the local language costs more, so the running cost has been raised by 30%.');

  return {
    route,
    switch_month: sw,
    setup_start_month: setupStart,
    ready_month: readyMonth,
    cost_crossover_month: switchMonth,
    crossover_headcount: crossHead,
    headcount: heads,
    cumulative_stay_eor: stayEor,
    cumulative_plan: plan,
    total_stay_eor: stayEor[ROUTE_MONTHS - 1],
    total_plan: plan[ROUTE_MONTHS - 1],
    difference: plan[ROUTE_MONTHS - 1] - stayEor[ROUTE_MONTHS - 1],
    running_cost_used: r0(running),
    checks: { financial, risk, strategic, score },
    steps,
    flags
  };
}
