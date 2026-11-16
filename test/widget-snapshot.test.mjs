import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { widgetPublisher, widgetSnapshot } from '../desktop/widget-snapshot.mjs';
import { createDashboard } from '../dashboard.mjs';

const ids = ['A', 'B', 'C'].map(a => 'UC' + a.repeat(22));
const updated = '2026-04-01T12:00:00.000Z';
const clock = new Date('2026-04-01T15:00:00Z');
function fixture() {
  const channels = ids.map((id, index) => ({ id, title: 'Channel ' + index, subscribers: index === 0 ? null : 100,
    lifetimeViews: 1000 + index, description: 'do-not-publish',
    video: { title: 'Release ' + index, publishedAt: updated, views: index, description: 'do-not-publish' } }));
  const dashboard = {
    youtube: { configured: true, data: channels, updatedAt: updated, error: 'do-not-publish' },
    apple: { configured: true, keyId: 'do-not-publish', updatedAt: updated, data: {
      days: 7, from: '2026-03-25', through: '2026-03-31', reportedDays: 5, complete: false, warning: 'do-not-publish', apps: [
        { title: 'Beta', paidDownloads: 4, freeDownloads: 10, inAppPurchases: 2, proceeds: { USD: 25.10, EUR: 18 }, sku: 'do-not-publish' },
        { title: 'Gamma', paidDownloads: -1, freeDownloads: 2, inAppPurchases: 15, proceeds: { USD: 1.23 }, previousProceeds: { USD: 900 } },
      ],
    } },
  };
  const studio = {
    connected: true, updatedAt: updated, error: null, data: {
      from: '2026-03-02', through: '2026-03-29', days: 28, daily: ['do-not-publish'],
      totals: { views: 405, estimatedMinutesWatched: 30.5, subscribersGained: 14, subscribersLost: 2 },
    },
  };
  const analytics = { clientId: 'do-not-publish', channels: { [ids[0]]: studio, [ids[1]]: studio,
    [ids[2]]: { ...studio, connected: false } } };
  return { dashboard, analytics, settings: { onboarded: true, sources: ['youtube','apple'], visibleChannelIds: [ids[0], ids[2]] } };
}

test('includes only visible channel and metric fields, dates and currency-specific net sales', () => {
  const { dashboard, settings, analytics } = fixture();
  const result = widgetSnapshot(dashboard, settings, analytics, clock);
  assert.equal(result.version, 1);
  assert.equal(result.youtubeStale, true);
  assert.deepEqual(result.channels.map(c => c.id), [ids[0], ids[2]]);
  assert.equal(result.channels[0].subscribers, null);
  assert.equal(result.channels[0].latest.views, 0);
  assert.equal(result.channels[0].studio.estimatedMinutesWatched, 30.5);
  assert.equal(result.channels[0].studio.through, '2026-03-29');
  assert.equal(result.channels[1].studio, null);
  assert.equal(result.sales.paidDownloads, 3);
  assert.equal(result.sales.inAppPurchases, 17);
  assert.equal(result.sales.freeDownloads, 12);
  assert.deepEqual(result.sales.proceeds, { EUR: 18, USD: 26.33 });
  assert.deepEqual(result.sales.topApp, { title: 'Gamma', paidDownloads: -1, inAppPurchases: 15 });
  assert.equal(result.sales.reportedDays, 5);
  assert.equal(result.sales.days, 7);
  assert.equal(result.sales.through, '2026-03-31');
  const output = JSON.stringify(result);
  assert.ok(!output.includes('do-not-publish') && !output.includes(ids[1]) && !output.includes('Beta'));
});

test('respects source toggles, empty selection, missing coverage and expiry independently', () => {
  const { dashboard, settings, analytics } = fixture();
  const result = () => widgetSnapshot(dashboard, settings, analytics, clock);
  settings.onboarded = false;
  assert.deepEqual(result().channels, []);
  assert.equal(result().sales, null);
  settings.onboarded = true;
  settings.visibleChannelIds = [];
  assert.equal(result().youtubeUpdatedAt, null);
  assert.deepEqual(result().channels, []);
  settings.visibleChannelIds = null;
  settings.sources = ['youtube'];
  assert.equal(result().sales, null);
  assert.equal(result().channels.length, 3);
  analytics.channels[ids[0]].updatedAt = '2026-02-01T00:00:00Z';
  assert.equal(result().channels[0].studio, null);
  assert.ok(result().channels[0].latest);
  dashboard.youtube.updatedAt = '2026-02-28T00:00:00Z';
  assert.deepEqual(result().channels, []);
  settings.sources = ['apple'];
  dashboard.apple.data.reportedDays = 0;
  assert.equal(result().sales.paidDownloads, null);
  assert.equal(result().sales.freeDownloads, null);
  assert.deepEqual(result().sales.proceeds, {});
  assert.equal(result().sales.topApp, null);
  dashboard.apple.data.reportedDays = 7;
  dashboard.apple.data.apps = [];
  assert.equal(result().sales.paidDownloads, 0);
  assert.equal(result().sales.inAppPurchases, 0);
});

test('selects newest published uploads and matches detailed metrics by video ID without inventing trends', () => {
  const { dashboard, settings, analytics } = fixture();
  const channel = dashboard.youtube.data[0];
  const recent = { id: 'recent', title: 'Recent', publishedAt: updated, views: 10 };
  const top = { id: 'older', title: 'Older', publishedAt: '2026-03-31T05:00:00Z', views: 100, likes: 5, comments: null };
  channel.video = { ...recent, views: 8 };
  channel.videos = [top, { ...recent, likes: 0, comments: 7, description: 'do-not-publish' },
    { ...top, id: 'scheduled', publishedAt: '2026-05-04T12:00:00Z' }];
  const result = widgetSnapshot(dashboard, settings, analytics, clock).channels[0];
  assert.equal(result.videos.length, 2);
  assert.deepEqual(result.latest, { ...recent, likes: 0, comments: 7 });
  assert.deepEqual(result.videos[1], top);
  channel.video = top; // Historical snapshots can have a stale most-recent pointer.
  assert.equal(widgetSnapshot(dashboard, settings, analytics, clock).channels[0].latest.id, 'recent');
});

test('Studio charts align to actual report dates and keep unknown counts distinct from zero', () => {
  const { dashboard, settings, analytics } = fixture();
  analytics.channels[ids[0]].data.daily = [
    { date: '2026-03-27', subscribersGained: 2, subscribersLost: 2, geo: 'do-not-publish' },
    { date: '2026-03-29', subscribersGained: null, subscribersLost: 1 },
    { date: '2026-03-26', subscribersGained: 0, subscribersLost: 4 },
    { date: '2026-03-01', subscribersGained: 99, subscribersLost: 1 },
  ];
  const studio = widgetSnapshot(dashboard, settings, analytics, clock).channels[0].studio;
  assert.equal(studio.daily.length, 28);
  assert.equal(studio.daily[0].date, studio.from);
  assert.equal(studio.daily.at(-1).date, studio.through);
  assert.deepEqual(studio.daily.slice(-4).map(day => day.netSubscribers), [-4, 0, null, null]);
  assert.deepEqual(studio.daily.at(-2), { date: '2026-03-28', subscribersGained: null, subscribersLost: null, netSubscribers: null });
  assert.ok(!JSON.stringify(studio).includes('do-not-publish'));
});

test('imported Apple reports produce seven dated net sales without requests or raw cache data', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'argus-widget-sales-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { dashboard, settings, analytics } = fixture();
  const record = { account: 'test-account', updatedAt: updated, data: dashboard.apple.data, cache: {
    version: 1, owner: 'do-not-publish', reports: {
      '2026-03-24': { apps: [{ paidDownloads: 655 }] },
      '2026-03-25': { apps: [{ paidDownloads: -1 }, { paidDownloads: 5, sku: 'do-not-publish' }] },
      '2026-03-26': { noSales: true, apps: [] }, '2026-03-27': { apps: [] },
      '2026-03-29': { apps: [{ paidDownloads: null }] }, '2026-03-30': { apps: [{ paidDownloads: -1 }] },
      '2026-03-31': { apps: [{ paidDownloads: 1000 }] },
    },
  } };
  record.data.missingDays = ['2026-03-31']; // A longer report later filled this hole in the reusable cache.
  await writeFile(path.join(dir, 'apple.json'), JSON.stringify(record));
  const saved = await createDashboard({ dir, vault: () => { throw Error('Unexpected vault read'); },
    apple: () => { throw Error('Unexpected Apple request'); } });
  settings.sources = ['apple'];
  assert.ok(!('dailyPaidDownloads' in saved.state().apple));
  const widget = widgetSnapshot(saved.state({ includeDailySales: true }), settings, analytics, clock);
  assert.deepEqual(widget.channels, []);
  assert.deepEqual(widget.sales.daily.map(row => row.paidDownloads), [4, 0, 0, null, null, -1, null]);
  assert.equal(widget.sales.daily[0].date, widget.sales.from);
  assert.equal(widget.sales.daily.at(-1).date, widget.sales.through);
  assert.ok(!JSON.stringify(widget).includes('do-not-publish'));

  const historical = await createDashboard({ dir, vault: async () => '{}', apple: async () => ({
    cache: { version: 1, reports: { '2026-03-25': { apps: [{ paidDownloads: 999 }] } } },
  }) });
  await historical.applePeriod(30);
  assert.deepEqual(historical.state({ includeDailySales: true }).apple.dailyPaidDownloads, widget.sales.daily);
});

test('serializes updates, replaces hidden data, and reloads WidgetKit only on a changed snapshot', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'argus-widget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'widget-snapshot.json');
  const { dashboard, settings, analytics } = fixture();
  let reloads = 0;
  const context = { file, readSnapshot: () => widgetSnapshot(dashboard, settings, analytics, clock),
    reload: () => { reloads++; }, now: () => clock };
  let publish = widgetPublisher(context);
  assert.deepEqual(await Promise.all([publish(), publish(), publish()]), [true, false, false]);
  assert.equal(reloads, 1);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.updatedAt, clock.toISOString());
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  publish = widgetPublisher(context); // Restart should not trigger a redundant timeline update.
  assert.equal(await publish(), false);
  assert.equal(reloads, 1);
  settings.sources = ['youtube'];
  settings.visibleChannelIds = [ids[2]];
  await publish();
  const reduced = await readFile(file, 'utf8');
  assert.equal(JSON.parse(reduced).sales, null);
  assert.ok(!reduced.includes(ids[0]) && !reduced.includes('Gamma'));
  assert.equal(reloads, 2);
  assert.deepEqual(await readdir(dir), ['widget-snapshot.json']);
});
