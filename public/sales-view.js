import { element, day, count, money, metric, control, notice, tableFrame } from './ui.js';

export const ranges = [1, 7, 30, 90];

export function reportFilters(data, preferences) {
  const currencies = [...new Set((data?.apps || []).flatMap(app => [...Object.keys(app.proceeds || {}), ...Object.keys(app.previousProceeds || {})]))]
    .filter(code => /^[A-Z]{3}$/.test(code)).sort();
  const currency = currencies.includes(preferences.currency) ? preferences.currency : currencies.includes('USD') ? 'USD' : currencies[0] || null;
  const orders = [['paidDownloads', 'Paid downloads'], ['freeDownloads', 'Free downloads'], ['inAppPurchases', 'In-app purchases']];
  if (currency) orders.unshift(['proceeds', 'Estimated proceeds']);
  const order = orders.some(([key]) => key === preferences.order) ? preferences.order : orders[0][0];
  return { currency, order, currencies, orders };
}

export function salesHeader(days, actions, data) {
  const box = element('div');
  const rangesNav = element('nav', 'channel-tabs range-tabs');
  rangesNav.setAttribute('aria-label', 'Sales report period');
  for (const n of ranges) {
    const tab = element('a', '', n === 1 ? '1 day' : n + ' days');
    tab.href = '#apple/' + n;
    if (n === days) tab.setAttribute('aria-current', 'page');
    rangesNav.append(tab);
  }
  const header = element('header', 'report-head');
  const title = element('div');
  title.append(element('p', 'eyebrow violet', 'App Store Connect'), element('h1', '', 'App sales'));
  const span = data ? (data.from === data.through ? day(data.through) : day(data.from) + ' – ' + day(data.through)) + ' · Pacific time' : days + '-day report';
  title.append(element('p', 'subtitle', span));
  header.append(title, actions);
  box.append(rangesNav, header);
  return box;
}

export function renderSales(box, data, filters, update) {
  const { currency, order, currencies, orders } = filters;
  const { apps, missingDays = [] } = data;
  const days = data.days ?? 7;
  const partial = missingDays.some(date => date >= data.from && date <= data.through);
  const comparing = data.complete !== false && !missingDays.length;
  if (data.warning) box.append(notice(data.warning));
  if (!data.reportedDays && data.reportedDays !== undefined) {
    box.append(element('p', 'data-empty', 'Waiting for a report covering this period.'));
    return;
  }

  const proceeds = (map, complete) => currency ? map?.[currency] ?? (complete ? 0 : null) : null;
  const currentValue = app => order === 'proceeds' ? proceeds(app.proceeds, !partial) : app[order];
  const previousKey = 'previous' + order[0].toUpperCase() + order.slice(1);
  const metricLabel = orders.find(([key]) => key === order)[1].toLowerCase();
  const sumUnits = key => apps.reduce((sum, app) => sum + app[key], 0);
  const currentMoney = apps.map(app => proceeds(app.proceeds, !partial)).filter(Number.isFinite);
  const facts = element('dl', 'stat-band sales-band');
  const cover = partial ? data.reportedDays + ' of ' + days + ' days reported' : days === 1 ? 'Reporting day' : 'Selected ' + days + ' days';
  facts.append(
    metric('Estimated proceeds', money(currentMoney.length ? currentMoney.reduce((sum, n) => sum + n, 0) : null, currency), currency || 'Currency unavailable'),
    metric('Paid downloads', count(sumUnits('paidDownloads')), cover),
    metric('In-app purchases', count(sumUnits('inAppPurchases')), cover),
    metric('Free downloads', count(sumUnits('freeDownloads')), cover)
  );
  box.append(facts);
  if (!apps.length) {
    box.append(element('p', 'data-empty', missingDays.length
      ? 'No app rows in the available reports. Missing dates may contain activity.'
      : 'No app sales or downloads reported in this period.'));
    return;
  }

  const panel = element('section', 'panel');
  const toolbar = element('div', 'panel-title');
  toolbar.append(element('h2', '', 'App performance'));
  const controls = element('div', 'filters');
  controls.append(control('Rank by', orders, order, value => update('order', value)));
  if (currency) controls.append(control('Currency', currencies.map(code => [code,code]), currency, value => update('currency', value)));
  toolbar.append(controls);
  const ranked = [...apps].sort((a, b) => {
    const av = currentValue(a);
    const bv = currentValue(b);
    if (Number.isFinite(av) !== Number.isFinite(bv)) return Number.isFinite(av) ? -1 : 1;
    return (bv || 0) - (av || 0) || a.title.localeCompare(b.title);
  });
  const { scroll, body } = tableFrame(partial ? 'App totals for available report dates' : 'App totals for selected period', [
    'App', 'Paid downloads', 'Free downloads', 'In-app purchases', currency ? 'Proceeds (' + currency + ')' : 'Proceeds', 'Change in ' + metricLabel
  ]);
  for (const app of ranked) {
    const row = element('tr');
    const name = element('th', '', app.title);
    name.scope = 'row';
    row.append(name);
    for (const key of ['paidDownloads', 'freeDownloads', 'inAppPurchases']) row.append(element('td', '', count(app[key])));
    row.append(element('td', 'amount', money(proceeds(app.proceeds, !partial), currency)));
    const current = currentValue(app);
    const prev = order === 'proceeds' ? proceeds(app.previousProceeds, comparing) : app[previousKey];
    const change = comparing && Number.isFinite(current) && Number.isFinite(prev) ? current - prev : null;
    const delta = Number.isFinite(change) ? (change > 0 ? '+' : '') + (order === 'proceeds' ? money(change, currency) : count(change)) : '—';
    row.append(element('td', change > 0 ? 'positive' : change < 0 ? 'negative' : '', delta));
    body.append(row);
  }
  panel.append(toolbar, scroll, element('p', 'note', comparing
    ? 'Changes compare ' + metricLabel + ' with the prior ' + (days === 1 ? 'day' : days + ' days') + ' beginning ' + day(data.comparisonFrom) + '.'
    : 'Changes are unavailable until both periods have complete reports.'));
  box.append(panel);
}
