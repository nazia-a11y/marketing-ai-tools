// Global Hiring Planner: the formulas, shared word for word by the page and the server.
// Employer contribution rules are 2026 figures from government sources and the big accounting firms' tax guides.
// Setup and running costs are typical estimates from local advisers; users can replace them with real quotes.
const clampTo = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const ROUTE_COUNTRIES = {
  uk: {
    name: 'United Kingdom', currency: 'GBP', english: true, salary: 60000,
    fee: 475, payroll: 40, setup: 1500, running: 1000, setup_months: 1.5, setup_range: '2 to 6 weeks', entity: 'private limited company (Ltd)',
    employer: (s) => 0.15 * Math.max(0, s - 5000) + 0.03 * clampTo(s - 6240, 0, 44030),
    employer_text: 'National Insurance of 15% above £5,000 a year, and at least 3% pension on earnings between £6,240 and £50,270',
    notes: ['No minimum share capital. A UK subsidiary of a larger group usually needs an audit.'],
    eor: 'Employer of record is lawful in the UK. If people work under your direction, they are entitled to the same pay and conditions as your own staff after 12 weeks.',
    eor_limit: null
  },
  ie: {
    name: 'Ireland', currency: 'EUR', english: true, salary: 60000,
    fee: 515, payroll: 45, setup: 3000, running: 1200, setup_months: 2.5, setup_range: '6 to 10 weeks', entity: 'private company limited by shares (LTD)',
    employer: (s) => s * (s / 52 > 552 ? 0.1125 : 0.09) + 0.015 * Math.min(s, 80000),
    employer_text: 'PRSI of 11.25% on all pay above €552 a week (9% below), and 1.5% auto-enrolment pension up to €80,000',
    notes: ['The company needs a director living in the European Economic Area, or a bond of about €25,000 instead.'],
    eor: 'A 2026 Workplace Relations Commission decision treated an employer of record as an employment agency, which needs a licence in Ireland. Check that the provider holds one.',
    eor_limit: null
  },
  de: {
    name: 'Germany', currency: 'EUR', english: false, salary: 70000,
    fee: 515, payroll: 45, setup: 5000, running: 2000, setup_months: 2.5, setup_range: '6 to 12 weeks', entity: 'GmbH',
    employer: (s) => 0.112 * Math.min(s, 101400) + 0.1055 * Math.min(s, 69750) + 0.011 * s + 0.021 * Math.min(s, 101400),
    employer_text: 'pension, unemployment, health, care and accident insurance and the small-employer sick pay levy, about 25% of pay, falling above the ceilings of €69,750 and €101,400',
    notes: ['A GmbH needs €25,000 share capital, with €12,500 paid in before registration.'],
    eor: 'In Germany an employer of record must hold a labour leasing licence, and the same person can usually be placed with you for at most 18 months.',
    eor_limit: 18
  },
  fr: {
    name: 'France', currency: 'EUR', english: false, salary: 60000,
    fee: 515, payroll: 45, setup: 4000, running: 2000, setup_months: 2, setup_range: '3 to 8 weeks', entity: 'SAS',
    employer: (s) => 0.235 * s + 0.1466 * Math.min(s, 48060) + 0.0425 * Math.min(s, 192240) + 0.1478 * clampTo(s - 48060, 0, 336420),
    employer_text: 'health, family, pension, unemployment and other contributions, about 40% to 45% of pay. Pay below about €65,600 gets a reduction this tool does not apply, so it slightly overstates cost there',
    notes: ['Employers must also pay at least half of a company health plan, which is not included here.'],
    eor: 'France restricts lending workers for profit. Employer of record usually runs through wage portage, which only suits skilled, autonomous people on temporary assignments, for up to 36 months.',
    eor_limit: 18
  },
  nl: {
    name: 'Netherlands', currency: 'EUR', english: false, salary: 65000,
    fee: 515, payroll: 45, setup: 3500, running: 1500, setup_months: 2, setup_range: '3 to 8 weeks', entity: 'BV',
    employer: (s) => 0.08 * s + 0.1713 * Math.min(s * 1.08, 79409),
    employer_text: 'the 8% holiday allowance, plus unemployment, disability, return-to-work and health levies of about 17% up to €79,409',
    notes: ['If your sector has a mandatory pension fund, its contributions are extra.'],
    eor: 'People employed through a provider must get the same terms as your own staff. A licensing system for labour supply starts in 2027.',
    eor_limit: null
  },
  es: {
    name: 'Spain', currency: 'EUR', english: false, salary: 50000,
    fee: 515, payroll: 45, setup: 4000, running: 550, setup_months: 2, setup_range: '4 to 10 weeks', entity: 'Sociedad Limitada (SL)',
    employer: (s) => 0.3165 * Math.min(s, 61214.4) + 0.011 * Math.max(0, s - 61214.4),
    employer_text: 'social security of about 31.65% of pay up to €61,214, and about 1.1% above it. Annual gross already includes the extra payments',
    notes: ['A foreign company can also register directly as an employer in Spain without a subsidiary, which can suit one or two hires.'],
    eor: 'Spanish law has no employer of record category. Supplying workers to another company is reserved for licensed temporary work agencies, so a long-term arrangement risks being treated as illegal worker supply.',
    eor_limit: 0
  },
  pl: {
    name: 'Poland', currency: 'PLN', english: false, salary: 240000,
    fee: 2200, payroll: 185, setup: 8000, running: 1500, setup_months: 2, setup_range: '6 to 8 weeks, longer if the bank account is slow', entity: 'sp. z o.o.',
    employer: (s) => 0.2198 * Math.min(s, 282600) + 0.0572 * Math.max(0, s - 282600),
    employer_text: 'pension, disability, accident, Labour Fund and guaranteed benefits contributions, plus 1.5% workplace pension, about 22% up to PLN 282,600',
    notes: ['An sp. z o.o. needs PLN 5,000 share capital.'],
    eor: 'If an employer of record is set up as temporary agency work, the same person can be placed with you for at most 18 months in any 36. From July 2026 the labour inspectorate can also reclassify contracts as employment.',
    eor_limit: 18
  },
  sg: {
    name: 'Singapore', currency: 'SGD', english: true, salary: 120000,
    fee: 780, payroll: 65, setup: 3000, running: 1000, setup_months: 1, setup_range: '1 to 4 weeks', entity: 'private limited company (Pte Ltd)',
    employer: (s, i) => (i.citizens ? 0.17 * Math.min(s, 102000) : 0) + Math.min(0.0025 * s / 12, 11.25) * 12,
    employer_text: 'CPF of 17% up to S$102,000 for citizens and permanent residents, and the Skills Development Levy for everyone',
    notes: ['The company needs a resident director and a company secretary. Running costs include a nominee director.'],
    eor: 'Since 2024 an employer of record cannot sponsor work passes in Singapore, so hiring people who need an Employment Pass needs your own company.',
    eor_limit: null
  },
  au: {
    name: 'Australia', currency: 'AUD', english: true, salary: 130000,
    fee: 910, payroll: 75, setup: 5000, running: 1200, setup_months: 1.5, setup_range: '2 to 6 weeks', entity: 'proprietary company (Pty Ltd)',
    employer: (s) => 0.12 * Math.min(s, 270830),
    employer_text: 'superannuation of 12% up to A$270,830. Payroll tax (5.45% in New South Wales) only applies once total wages pass A$1.2 million, and is added for your team when it does',
    payroll_tax: { rate: 0.0545, threshold: 1200000 },
    notes: ['The company needs a director who lives in Australia. A subsidiary usually needs audited accounts unless the group is small.'],
    eor: 'Employer of record can count as labour hire. Victoria, Queensland and the ACT require labour hire licences.',
    eor_limit: null
  },
  ca: {
    name: 'Canada (Ontario)', currency: 'CAD', english: true, salary: 110000,
    fee: 825, payroll: 70, setup: 5000, running: 1200, setup_months: 1.5, setup_range: '4 to 6 weeks', entity: 'Ontario corporation',
    employer: (s) => 0.0595 * Math.max(0, Math.min(s, 74600) - 3500) + 0.04 * Math.max(0, Math.min(s, 85000) - 74600) + 0.02282 * Math.min(s, 68900),
    employer_text: 'CPP, CPP2 and employment insurance, which stop at their yearly maximums. Ontario Employer Health Tax (1.95%) only applies once total wages pass C$1 million, and is added for your team when it does',
    payroll_tax: { rate: 0.0195, threshold: 1000000 },
    notes: ['No minimum capital and no resident director needed for an Ontario corporation.'],
    eor: 'Since July 2024 temporary help agencies placing workers in Ontario need a licence. Check that the provider holds one.',
    eor_limit: null
  }
};
const ROUTE_LANGUAGE_UPLIFT = 1.3;                      // running cost uplift when you do not work in the local language
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
  const c = ROUTE_COUNTRIES[i.country] || ROUTE_COUNTRIES.uk;
  const heads = routeHeadcount(i);

  // The cost of employing one person, which is the same on either route.
  const employer = c.employer(i.salary, i);
  const perPerson = i.salary + employer;
  const payTax = (h) => (c.payroll_tax ? c.payroll_tax.rate * Math.max(0, h * i.salary - c.payroll_tax.threshold) / 12 : 0);
  let teamCost = 0;
  for (const h of heads) teamCost += h * perPerson / 12 + payTax(h);

  // Route costs, on top of pay.
  const running = i.running * (c.english || i.local_language ? 1 : ROUTE_LANGUAGE_UPLIFT);
  const eorMonth = (h) => h * i.fee;
  const ownMonth = (h) => running + h * i.payroll;
  const setupMonths = Math.ceil(c.setup_months);
  const readyMonth = setupMonths + 1;              // earliest month your own company can employ people

  // Month by month, when does your own company become cheaper to run than employer of record?
  let switchMonth = null;
  for (let m = 1; m <= ROUTE_MONTHS; m++) if (eorMonth(heads[m - 1]) >= ownMonth(heads[m - 1]) && heads[m - 1] > 0) { switchMonth = m; break; }
  const crossHead = i.fee > i.payroll ? Math.ceil(running / (i.fee - i.payroll)) : null;

  // Cost of a plan that uses employer of record until a given month, then your own company.
  // People who need work passes in Singapore cannot be employed through employer of record, so nobody starts before your own company is ready.
  const passes = i.country === 'sg' && !i.citizens;
  const planCost = (sw) => {
    const cum = [];
    let t = 0;
    for (let m = 1; m <= ROUTE_MONTHS; m++) {
      if (sw !== null && m === Math.max(1, sw - setupMonths)) t += i.setup;
      t += sw !== null && m >= sw ? ownMonth(heads[m - 1]) : (sw !== null && passes ? 0 : eorMonth(heads[m - 1]));
      cum.push(r0(t));
    }
    return cum;
  };
  const stayEor = planCost(null);
  const financialSwitch = switchMonth === null ? null : Math.max(switchMonth, readyMonth);
  const financialPlan = financialSwitch === null ? null : planCost(financialSwitch);
  const financial = financialPlan !== null && financialPlan[ROUTE_MONTHS - 1] < stayEor[ROUTE_MONTHS - 1];

  // Country rules that limit employer of record count as a risk when people would stay on it beyond the limit.
  const limitHit = c.eor_limit !== null && heads.some((h, k) => h > 0 && k + 1 > c.eor_limit);
  // Risks that need your own company as soon as it can be ready, as opposed to a time limit you can plan around.
  const urgentRisk = !!(i.risk_sales || i.risk_manager || i.risk_licences || i.risk_regulated || passes || (c.eor_limit === 0 && heads.some((h) => h > 0)));
  const risk = urgentRisk || limitHit;
  const strategic = !!(i.plan_permanent || i.ma);
  const score = [financial, risk, strategic].filter(Boolean).length;

  // Pick the plan.
  let route, sw = null;
  if (passes) {
    route = 'own';
    sw = readyMonth;
  } else if (score >= 2) {
    route = 'own';
    // Switch as soon as possible for urgent risks, otherwise when your own company becomes cheaper,
    // and never later than a country's limit on employer of record.
    if (urgentRisk) sw = readyMonth;
    else if (financial) sw = financialSwitch;
    else sw = limitHit ? c.eor_limit : readyMonth;
    if (limitHit) sw = Math.max(readyMonth, Math.min(sw, c.eor_limit));
  } else {
    route = 'eor';
  }
  const plan = route === 'own' ? planCost(sw) : stayEor;
  const setupStart = sw === null ? null : Math.max(1, sw - setupMonths);
  const needBy = ROUTE_URGENCY_MONTHS[i.urgency] || 3;
  const bridge = route === 'own' && !passes && (heads[0] > 0 || needBy < readyMonth);

  const steps = [];
  if (route === 'own') {
    if (setupStart === 1) steps.push('Start setting up your ' + c.entity + ' now. It usually takes ' + c.setup_range + ' in ' + c.name + '.');
    else steps.push('Start setting up your ' + c.entity + ' in month ' + setupStart + '. It usually takes ' + c.setup_range + ' in ' + c.name + '.');
    if (passes) steps.push('Your hires need work passes, which only your own company can sponsor, so they can start in month ' + sw + ', once it is ready.');
    else if (bridge || sw > 1) steps.push('Use employer of record for your first hires' + (sw > 1 ? ' until month ' + sw : '') + ', so you can hire straight away.');
    const why = urgentRisk ? ', as soon as it is ready, because of the risks flagged below'
      : financial && sw === financialSwitch ? ', when it becomes cheaper to run than employer of record'
      : limitHit && sw === c.eor_limit ? ', before the ' + c.eor_limit + '-month limit on employer of record in ' + c.name
      : ', as soon as it is ready, for the permanent presence you plan';
    if (!passes) steps.push('Move your team onto your own company in month ' + sw + why + '.');
  } else {
    steps.push('Hire through employer of record. You can start within days or weeks, with no setup cost.');
    if (switchMonth !== null) steps.push('Review the decision in month ' + Math.max(1, switchMonth - setupMonths) + '. Your own company starts to cost less to run at about ' + (crossHead || heads[switchMonth - 1]) + ' people, around month ' + switchMonth + '.');
    else steps.push('At this hiring plan, your own company does not become cheaper within 24 months. Review the decision if your plans grow.');
    if (limitHit) steps.push('Plan for the ' + c.eor_limit + '-month limit on employer of record in ' + c.name + '. By month ' + c.eor_limit + ', move people onto your own company or end their placements.');
  }

  const flags = [];
  if (c.eor_limit === 0) flags.push(c.eor + ' Take local legal advice before using employer of record for anything beyond a short, temporary need.');
  else if (limitHit) flags.push(c.eor + ' Your plan keeps people in the country beyond month ' + c.eor_limit + ', so this counts as a risk.');
  else flags.push(c.eor);
  if (passes) flags.push('You said your hires are not Singapore citizens or permanent residents, so they will need work passes, which your own company must sponsor.');
  if (i.risk_sales || i.risk_manager) flags.push('Staff who sign contracts, close local sales or run the local operation can create a taxable presence in that country, even through employer of record. Get tax advice for that country before they start.');
  if (i.risk_licences) flags.push('Local licences, contracts in your own name, public tenders or local data storage usually need your own local company.');
  if (i.risk_regulated) flags.push('Regulated sectors often need a local company from the start. Check the rules for that country early.');
  if (i.ma) flags.push('Acquisitions and carve-outs come with fixed deadlines, so plan payroll and employment transfers in parallel with the deal.');
  if (i.exclusive) flags.push('People who work only for you, full-time and under your direction, are usually treated as employees. Using contractors for them is risky, so employer of record or your own company is the safer choice.');
  if (!c.english && !i.local_language) flags.push('Running a company where you do not work in the local language costs more, so the running cost has been raised by 30%.');

  return {
    country: c.name,
    currency: c.currency,
    salary: i.salary,
    employer_costs_per_person: r0(employer),
    cost_per_person_year: r0(perPerson),
    team_cost_24_months: r0(teamCost),
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
    country_rules: { eor_limit_months: c.eor_limit, limit_applies: limitHit, needs_work_pass_sponsor: passes },
    steps,
    flags
  };
}
