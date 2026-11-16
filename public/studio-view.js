import { element, link, count, day, metric, notice, tableFrame, timestamp } from './ui.js';

function breakdown(title, list, key) {
  const section = element('section', 'breakdown');
  section.append(element('h3', '', title));
  if (!list?.length) {
    section.append(element('p', 'muted', 'No rows available for this period.'));
    return section;
  }
  const { body, scroll } = tableFrame(title, [key === 'country' ? 'Country' : 'Source', 'Views', 'Watch time (h)']);
  for (const item of list) {
    const row = element('tr');
    const code = String(item[key] ?? '');
    let label = code;
    if (key === 'country' && /^[A-Z]{2}$/.test(code)) {
      try { label = new Intl.DisplayNames(undefined, {type:'region'}).of(code); } catch {}
    } else if (key === 'source') label = code.toLowerCase().replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
    const th = element('th', '', label || 'Unknown');
    th.scope = 'row';
    row.append(th, element('td', '', count(item.views)), element('td', '', hours(item.estimatedMinutesWatched)));
    body.append(row);
  }
  section.append(scroll);
  return section;
}

const hours = m => Number.isFinite(m) ? (m / 60).toLocaleString(undefined, {maximumFractionDigits: 1}) : '—';

export function studio(channelId, analytics, controls) {
  const box = element('section', 'panel studio');
  const row = analytics?.channels?.[channelId];
  const data = row?.data;
  const header = element('div', 'panel-title');
  const title = element('div');
  title.append(element('p', 'eyebrow violet', 'Private channel data'), element('h2', '', 'Studio analytics'));
  header.append(title);
  const buttons = element('div', 'actions');
  if (!analytics?.clientConfigured) {
    buttons.append(link('Set up Google client →', '#connections/youtube/studio', 'button'));
  } else {
    if (row?.connected) {
      const refresh = element('button', 'button', 'Refresh analytics');
      refresh.disabled = controls.busy;
      refresh.addEventListener('click', () => controls.run('refresh'));
      buttons.append(refresh);
    }
    const connect = element('button', 'button', row?.connected ? 'Reconnect Google' : 'Connect Studio analytics');
    connect.disabled = controls.busy;
    connect.addEventListener('click', () => controls.run('connect'));
    buttons.append(connect);
  }
  header.append(buttons);
  box.append(header);
  if (controls.error || row?.error) box.append(notice(controls.error || row.error, true));
  if (controls.url) {
    const status = notice('Finish Google sign-in in your browser and choose this channel. ');
    status.append(link('Open Google sign-in ↗', controls.url, '', true));
    box.append(status);
  }
  if (!data) {
    box.append(element('p', 'studio-empty', row?.connected ? 'Waiting for the first analytics report.' : 'Connect this channel for daily views, watch time, subscriber changes and traffic sources.'));
    return box;
  }
  box.append(element('p', 'studio-caption', day(data.from) + ' – ' + day(data.through) + ' · Pacific time' + (row.updatedAt ? ' · Updated ' + timestamp(row.updatedAt) : '')));
  for (const message of data.warnings || []) box.append(notice(message));
  const total = element('dl', 'studio-metrics');
  total.append(metric('Views', count(data.totals.views)), metric('Watch time (h)', hours(data.totals.estimatedMinutesWatched)), metric('Avg. view duration', Number.isFinite(data.totals.averageViewDuration) ? Math.round(data.totals.averageViewDuration) + ' s' : '—'), metric('Subscribers gained', count(data.totals.subscribersGained)), metric('Subscribers lost', count(data.totals.subscribersLost)));
  box.append(total);
  if (data.daily?.length) {
    const graph = element('section', 'daily-graph');
    graph.append(element('h3', '', 'Daily views'));
    const chart = element('div', 'bars studio-bars');
    chart.setAttribute('aria-hidden', 'true');
    const peak = Math.max(...data.daily.map(d => d.views || 0));
    for (const d of data.daily) {
      const bar = element('span', 'chart-bar');
      if (d.views > 0) bar.style.height = (d.views / peak * 100) + '%';
      else bar.classList.add('zero');
      bar.title = day(d.date) + ' · ' + count(d.views) + ' views';
      if (peak && d.views === peak) bar.classList.add('peak');
      chart.append(bar);
    }
    const axis = element('div', 'axis');
    axis.append(element('span', '', day(data.daily[0].date, true)), element('span', '', 'Peak ' + count(peak)), element('span', '', day(data.daily.at(-1).date, true)));
    const details = element('details', 'daily-details');
    details.append(element('summary', '', 'Daily breakdown'));
    const { body, scroll } = tableFrame('Daily Studio analytics', ['Date','Views','Watch time (h)','Avg. view (s)','Subs gained','Subs lost']);
    for (const d of data.daily) {
      const tr = element('tr');
      const name = element('th', '', day(d.date));
      name.scope = 'row';
      tr.append(name, element('td','',count(d.views)),element('td','',hours(d.estimatedMinutesWatched)),element('td','',count(d.averageViewDuration)),element('td','',count(d.subscribersGained)),element('td','',count(d.subscribersLost)));
      body.append(tr);
    }
    details.append(scroll);
    graph.append(chart, axis, details);
    box.append(graph);
  }
  const detail = element('div', 'breakdowns');
  detail.append(breakdown('Traffic sources', data.trafficSources, 'source'), breakdown('Countries', data.countries, 'country'));
  box.append(detail);
  return box;
}
