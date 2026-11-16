import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

const maxYouTubeAge = 30 * 24 * 60 * 60 * 1000;
const channelId = /^UC[A-Za-z0-9_-]{22}$/;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}
function fresh(value, now) {
  return timestamp(value) && now - Date.parse(value) < maxYouTubeAge;
}
function number(value) {
  return Number.isFinite(value) ? value : null;
}
function label(value) {
  return typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, 140).join('') : '';
}
function period(report) {
  return [report?.from, report?.through].every(day => dateOnly.test(day) && Number.isFinite(Date.parse(day))) && report.from <= report.through;
}

function studioDays(report) {
  const rows = new Map((Array.isArray(report.daily) ? report.daily : []).map(row => [row?.date, row]));
  const result = [];
  const dayMs = 86400000;
  const end = Date.parse(report.through);
  const start = Math.max(Date.parse(report.from), end - 27 * dayMs);
  for (let time = start; time <= end; time += dayMs) {
    const date = new Date(time).toISOString().slice(0, 10);
    const row = rows.get(date);
    const subscribersGained = number(row?.subscribersGained);
    const subscribersLost = number(row?.subscribersLost);
    result.push({ date, subscribersGained, subscribersLost,
      netSubscribers: subscribersGained !== null && subscribersLost !== null ? subscribersGained - subscribersLost : null });
  }
  return result;
}

function studioSnapshot(record, now) {
  const report = record?.data;
  if (!record?.connected || !fresh(record.updatedAt, now) || !period(report) || !report.totals) return null;
  const totals = report.totals;
  return {
    from: report.from, through: report.through, views: number(totals.views),
    estimatedMinutesWatched: number(totals.estimatedMinutesWatched),
    subscribersGained: number(totals.subscribersGained), subscribersLost: number(totals.subscribersLost),
    daily: studioDays(report), updatedAt: record.updatedAt, stale: Boolean(record.error),
  };
}

function uploadSnapshot(channel, now) {
  const videos = new Map();
  // Early caches have only `video`. The detailed record in `videos` has
  // engagement counts and takes precedence for the same YouTube video ID.
  for (const item of [channel.video, ...(Array.isArray(channel.videos) ? channel.videos : [])]) {
    if (!timestamp(item?.publishedAt) || Date.parse(item.publishedAt) > now || item.liveStatus === 'upcoming') continue;
    const title = label(item.title);
    if (!title) continue;
    const id = label(item.id) || null;
    const key = id ?? item.publishedAt + '/' + title;
    const old = videos.get(key);
    videos.set(key, { id, title, publishedAt: item.publishedAt,
      views: number(item.views === undefined ? old?.views : item.views),
      likes: number(item.likes === undefined ? old?.likes : item.likes),
      comments: number(item.comments === undefined ? old?.comments : item.comments) });
  }
  return [...videos.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 25);
}

function salesSnapshot(record) {
  const report = record?.data;
  if (!record?.configured || !timestamp(record.updatedAt) || !period(report) || !Array.isArray(report.apps)) return null;
  const days = report.days ?? 7; // Pre-period-selection caches cover seven days.
  const reportedDays = report.reportedDays;
  if (!Number.isInteger(days) || days < 1 || !Number.isInteger(reportedDays) || reportedDays < 0 || reportedDays > days) return null;
  const sum = field => {
    if (!reportedDays || !report.apps.every(app => Number.isFinite(app[field]))) return null;
    return report.apps.reduce((total, app) => total + app[field], 0);
  };
  const byCurrency = new Map();
  let topApp = null;
  let highestPaidUnits = 0;
  for (const app of reportedDays ? report.apps : []) {
    for (const [currency, amount] of Object.entries(app.proceeds ?? {})) {
      if (/^[A-Z]{3}$/.test(currency) && Number.isFinite(amount)) {
        byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
      }
    }
    const paidUnits = app.paidDownloads + app.inAppPurchases;
    if (Number.isFinite(app.paidDownloads) && Number.isFinite(app.inAppPurchases) && paidUnits > highestPaidUnits) {
      highestPaidUnits = paidUnits;
      topApp = { title: label(app.title), paidDownloads: app.paidDownloads, inAppPurchases: app.inAppPurchases };
    }
  }
  const proceeds = Object.fromEntries([...byCurrency.keys()].sort().map(code => [code, Number(byCurrency.get(code).toFixed(6))]));
  return { from: report.from, through: report.through, days, reportedDays,
    paidDownloads: sum('paidDownloads'), freeDownloads: sum('freeDownloads'), inAppPurchases: sum('inAppPurchases'),
    proceeds, topApp, daily: (record.dailyPaidDownloads ?? []).map(row => ({ date: row.date, paidDownloads: number(row.paidDownloads) })),
    updatedAt: record.updatedAt, stale: Boolean(record.error) };
}

// This JSON is the widget extension's entire data contract. Construct each
// field explicitly so new private columns in provider caches never pass through.
export function widgetSnapshot(dashboard, settings, analytics, now = Date.now()) {
  const active = settings.onboarded ? settings.sources : [];
  const youtube = dashboard.youtube;
  const showYT = active.includes('youtube') && youtube?.configured && fresh(youtube.updatedAt, now);
  const selected = settings.visibleChannelIds === null ? null : new Set(settings.visibleChannelIds ?? []);
  const channels = [];
  for (const channel of showYT ? youtube.data ?? [] : []) {
    if (!channelId.test(channel.id) || (selected && !selected.has(channel.id))) continue;
    const videos = uploadSnapshot(channel, now);
    channels.push({
      id: channel.id, title: label(channel.title), subscribers: number(channel.subscribers), lifetimeViews: number(channel.lifetimeViews),
      latest: videos[0] ?? null, videos, studio: studioSnapshot(analytics?.channels?.[channel.id], now),
    });
  }
  return {
    version: 1, youtubeUpdatedAt: showYT && channels.length ? youtube.updatedAt : null,
    youtubeStale: Boolean(channels.length && youtube.error), channels,
    sales: active.includes('apple') ? salesSnapshot(dashboard.apple) : null,
  };
}

// The containing app already schedules refreshes. Compare published values,
// including source dates, and do no work when a tick has nothing new to show.
export function widgetPublisher({ file, readSnapshot, reload = () => {}, now = () => new Date() }) {
  let previous;
  let queue = Promise.resolve();
  async function publish() {
    const snapshot = readSnapshot();
    const current = JSON.stringify(snapshot);
    if (previous === undefined) {
      try {
        const { updatedAt, ...old } = JSON.parse(await readFile(file, 'utf8'));
        previous = timestamp(updatedAt) ? JSON.stringify(old) : null;
      } catch { previous = null; }
    }
    if (previous === current) return false;
    const tmp = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tmp, JSON.stringify({ ...snapshot, updatedAt: now().toISOString() }), { flag: 'wx', mode: 0o600 });
      await rename(tmp, file);
      previous = current;
    } catch (error) {
      // A user may just have hidden a private source. Remove the older widget
      // file if this revision cannot be published, then retry at the next tick.
      previous = null;
      await rm(file, { force: true }).catch(() => {});
      try { await reload(); } catch {}
      throw error;
    } finally { await rm(tmp, { force: true }).catch(() => {}); }
    try { await reload(); } catch {} // WidgetKit can still pick up the file on its budgeted timeline.
    return true;
  }
  return () => {
    const result = queue.then(publish);
    queue = result.catch(() => {});
    return result;
  };
}
