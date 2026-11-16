import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const integer = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
const number = value => Number.isFinite(value) ? integer.format(value) : '—';
const date = value => value && Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : '—';
const escape = value => String(value ?? '').replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[char]);
const labels = { paidDownloads: 'Paid downloads', freeDownloads: 'Free downloads', inAppPurchases: 'Paid in-app purchases', proceeds: 'Estimated proceeds' };

function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const parts = [Math.floor(seconds / 60) % 60, Math.floor(seconds % 60)];
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
  return parts.map((v, i) => i ? String(v).padStart(2, '0') : v).join(':');
}

function heading(type, title, metadata) {
  return '<header><div class="brand">Creator Dashboard</div><div class="type">' + escape(type) + '</div><h1>' +
    escape(title) + '</h1><p class="meta">' + metadata.filter(Boolean).map(escape).join(' · ') + '</p></header>';
}

function metrics(pairs) {
  return '<div class="metrics">' + pairs.map(([label, value]) => '<div><span>' + escape(label) +
    '</span><b>' + escape(value) + '</b></div>').join('') + '</div>';
}

function statsTable(headers, rows) {
  return '<table><thead><tr>' + headers.map(h => '<th>' + escape(h) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map(cells => '<tr>' + cells.map(cell => '<td>' + cell + '</td>').join('') +
    '</tr>').join('') + '</tbody></table>';
}

function privateAnalytics(record) {
  const data = record?.data;
  if (!data) return '';
  if (!data.days) return '<h2>Studio analytics</h2><p class="hint">' + escape(data.warnings?.[0] || 'YouTube has not returned a daily report yet.') + '</p>';
  const totals = data.totals;
  let body = '<h2>Studio analytics</h2><p class="hint">' + date(data.from) + ' – ' + date(data.through) + ' (Pacific) · Private channel data</p>';
  body += metrics([['Views', number(totals.views)], ['Watch hours', number(Number.isFinite(totals.estimatedMinutesWatched) ? totals.estimatedMinutesWatched / 60 : null)],
    ['Average view duration', duration(totals.averageViewDuration)], ['Subscribers gained / lost', number(totals.subscribersGained) + ' / ' + number(totals.subscribersLost)]]);
  if (record.error) body += '<p class="notice">Studio analytics uses the last successful private snapshot.</p>';
  for (const warning of data.warnings || []) body += '<p class="hint">' + escape(warning) + '</p>';
  if (data.trafficSources?.length || data.countries?.length) {
    const block = (name, dimension, list, label) => {
      if (!list?.length) return '';
      return '<div><h3>' + name + '</h3>' + statsTable([dimension, 'Views', 'Watch hours'], list.map(row => [
        escape(label(row)), number(row.views), number(Number.isFinite(row.estimatedMinutesWatched) ? row.estimatedMinutesWatched / 60 : null)
      ])) + '</div>';
    };
    const regions = new Intl.DisplayNames('en', { type: 'region' });
    body += '<div class="breakdowns">' + block('Traffic sources', 'Source', data.trafficSources, row => row.source.replaceAll('_', ' ').toLowerCase()) +
      block('Top countries', 'Country', data.countries, row => /^[A-Z]{2}$/.test(row.country) ? regions.of(row.country) : row.country) + '</div>';
  }
  if (data.daily?.length) {
    const points = data.daily.filter(row => Number.isFinite(row.views));
    const peak = Math.max(0, ...points.map(row => row.views));
    if (points.length) {
      body += '<div class="trend"><h3>Daily views</h3><div class="bars">' + points.map(row =>
        '<i style="height:' + (peak ? row.views / peak * 100 : 0).toFixed(2) + '%"></i>').join('') + '</div><div class="axis"><span>' +
        date(points[0].date) + '</span><span>Peak ' + number(peak) + ' views</span><span>' + date(points.at(-1).date) + '</span></div></div>';
    }
  }
  return body;
}

function channelReport(channel, record, analytics, sort) {
  const videos = Array.isArray(channel.videos) ? channel.videos : channel.video ? [channel.video] : [];
  const updated = record.updatedAt && timeFormat.format(new Date(record.updatedAt));
  let body = heading('YouTube / Channel report', channel.title, [channel.handle, channel.country, updated && 'Snapshot ' + updated]);
  body += metrics([['Subscribers', number(channel.subscribers)], ['Lifetime channel views', number(channel.lifetimeViews)],
    ['Public videos', number(channel.publicVideoCount)], ['Channel created', date(channel.joinedAt)]]);
  if (record.error) body += '<p class="notice">The last refresh failed. This report uses the saved snapshot.</p>';
  if (channel.description) body += '<h2>About the channel</h2><p class="description">' + escape(channel.description) + '</p>';
  body += privateAnalytics(analytics);
  if (videos.length) {
    const top = videos.filter(v => Number.isFinite(v.views)).sort((a, b) => b.views - a.views).slice(0, 3);
    if (top.length) {
      body += '<section class="top"><h2>Most viewed in the latest ' + videos.length + ' uploads</h2>';
      body += top.map(v => '<div class="track"><div><span>' + escape(v.title) + '</span><strong>' + number(v.views) +
        '</strong></div><div class="bar" style="width:' + (top[0].views ? 100 * v.views / top[0].views : 0).toFixed(1) + '%"></div></div>').join('') + '</section>';
    }
    const rankBy = ['views', 'likes', 'comments'].includes(sort) ? sort : null;
    const ordered = rankBy ? [...videos].sort((a, b) => (b[rankBy] ?? -1) - (a[rankBy] ?? -1)) : videos;
    body += '<h2>Recent public videos</h2><p class="hint">' + (rankBy ? 'Sorted by ' + rankBy : 'Newest first') +
      '. Counts are lifetime totals for each upload. Dates are in UTC.</p>';
    body += statsTable(['Title / Published', 'Length', 'Views', 'Likes', 'Comments'], ordered.map(v => [
      '<a href="https://www.youtube.com/watch?v=' + escape(encodeURIComponent(v.id)) + '">' + escape(v.title) + '</a><small>' +
        [date(v.publishedAt), v.liveStatus === 'live' ? 'Live now' : v.liveStatus === 'completed' ? 'Recorded livestream' : '', v.captions ? 'Captions' : ''].filter(Boolean).join(' · ') + '</small>',
      duration(v.durationSeconds), number(v.views), number(v.likes), number(v.comments)
    ]));
  } else body += '<p>No public uploads are available for this channel.</p>';
  body += '<p class="note">YouTube rounds subscriber counts down to three significant figures. A dash indicates an unavailable figure.</p>';
  return body;
}

function salesReport(report, options) {
  const days = report.days ?? 7;
  const currencies = [...new Set(report.apps.flatMap(app => [...Object.keys(app.proceeds), ...Object.keys(app.previousProceeds)]))].sort();
  const currency = options.currency && currencies.includes(options.currency) ? options.currency : currencies.includes('USD') ? 'USD' : currencies[0];
  const order = Object.hasOwn(labels, options.order) && (options.order !== 'proceeds' || currency)
    ? options.order : currency ? 'proceeds' : 'paidDownloads';
  const money = new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD', currencyDisplay: 'narrowSymbol' });
  const currentComplete = report.reportedDays === days;
  const proceeds = (map, complete) => currency ? map[currency] ?? (complete ? 0 : null) : null;
  const current = app => order === 'proceeds' ? proceeds(app.proceeds, currentComplete) : app[order];
  const previousKey = 'previous' + order[0].toUpperCase() + order.slice(1);
  const prior = app => order === 'proceeds' ? proceeds(app.previousProceeds, report.complete) : app[previousKey];
  const amount = n => Number.isFinite(n) ? money.format(n) : '—';
  const rankFormat = order === 'proceeds' ? amount : number;
  const previousEnd = new Date(report.from + 'T00:00:00Z');
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  let body = heading('App Store Connect / Sales report', days + '-day app performance', [
    date(report.from) + ' – ' + date(report.through) + ' (Pacific)', currency && 'Proceeds in ' + currency
  ]);
  body += '<p class="meta">Compared with ' + date(report.comparisonFrom) + ' – ' + date(previousEnd.toISOString()) + '.</p>';
  const total = key => report.reportedDays ? number(report.apps.reduce((sum, app) => sum + app[key], 0)) : '—';
  body += metrics([['Paid downloads', total('paidDownloads')], ['Free downloads', total('freeDownloads')], ['Paid in-app purchases', total('inAppPurchases')], ['Days reported', report.reportedDays + ' / ' + days]]);
  if (!report.complete) body += '<p class="notice">Partial report. Apple supplied ' + report.reportedDays + ' of ' + days +
    ' days in the selected period and ' + report.comparisonReportedDays + ' in the preceding period. Totals cover the available days. Changes are unavailable.</p>';
  const ranked = [...report.apps].sort((a, b) => {
    const av = current(a), bv = current(b);
    if (Number.isFinite(av) !== Number.isFinite(bv)) return Number.isFinite(av) ? -1 : 1;
    return (bv || 0) - (av || 0) || a.title.localeCompare(b.title);
  });
  if (ranked.length && report.reportedDays) {
    body += '<h2>App rankings</h2><p class="hint">Sorted by ' + labels[order].toLowerCase() + '. Change compares the selected ranking metric with the preceding period.</p>';
    body += statsTable(['App', 'Paid dl.', 'Free dl.', 'Paid IAP', 'Proceeds' + (currency ? ' (' + currency + ')' : ''), 'Change'], ranked.map(app => {
      const a = current(app), b = prior(app);
      const change = report.complete && Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
      return [escape(app.title), number(app.paidDownloads), number(app.freeDownloads), number(app.inAppPurchases),
        amount(proceeds(app.proceeds, currentComplete)), Number.isFinite(change) ? (change > 0 ? '+' : '') + rankFormat(change) : '—'];
    }));
  } else {
    body += '<p>' + (currentComplete ? 'No app activity appears in these reports.' : 'No app rows are available for the selected dates.') + '</p>';
  }
  if (report.missingDays?.length) body += '<h2>Unavailable report dates</h2><p class="hint">' + report.missingDays.map(date).join(' · ') + '</p>';
  body += '<p class="note">Source: Apple Summary Sales reports. Units include refunds. Proceeds are estimates in the selected currency. Updates and redownloads are excluded.</p>';
  return body;
}

const style = readFileSync(new URL('./report.css', import.meta.url), 'utf8');

export function reportDocument(state, options, periodReport) {
  let title, name, body;
  if (options.source === 'youtube') {
    const record = state.youtube;
    const channel = record?.data?.find(c => c.id === options.channelId);
    if (!channel) throw new Error('Select a connected YouTube channel with a saved snapshot.');
    title = channel.title + ' — Channel report';
    name = 'YouTube-' + channel.title + '-' + (record.updatedAt || new Date().toISOString()).slice(0, 10);
    body = channelReport(channel, record, state.analytics?.channels?.[channel.id], options.videoSort);
  } else if (options.source === 'apple' && periodReport) {
    title = 'App Store Connect sales report';
    name = 'App-Store-' + (periodReport.days ?? 7) + 'd-' + periodReport.through;
    body = salesReport(periodReport, options);
  } else throw new Error('Select a connected source to export.');
  const safeName = name.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-');
  const filename = [...safeName].slice(0, 120).join('') + '.pdf';
  const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;"><title>' +
    escape(title) + '</title><style>' + style + '</style><body>' + body + '</body></html>';
  return { filename, html };
}

export async function renderPdf(html) {
  const dir = await mkdtemp(path.join(tmpdir(), 'creator-report-'));
  try {
    const input = path.join(dir, 'report.html'), output = path.join(dir, 'report.pdf');
    await writeFile(input, html, { mode: 0o600 });
    await run(chrome, ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
      '--disable-extensions', '--disable-component-update', '--disable-breakpad', '--metrics-recording-only', '--no-pdf-header-footer',
      '--user-data-dir=' + path.join(dir, 'profile'), '--print-to-pdf=' + output, pathToFileURL(input).href], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    const pdf = await readFile(output);
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid PDF');
    return pdf;
  } catch (error) {
    throw new Error(error.code === 'ENOENT' && error.path === chrome ? 'PDF export requires Google Chrome in Applications on this Mac.' : 'The local PDF renderer could not finish. Please try again.');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
