import test from 'node:test';
import assert from 'node:assert/strict';
import { reportDocument } from '../reports.mjs';

test('channel report includes only the selected public and private snapshots and escapes remote titles', () => {
  const store = {
    youtube: { updatedAt: '2026-11-16T08:00:00Z', data: [
      { id: 'one', title: 'บันทึก <script>', subscribers: 40, videos: [{ id: 'v1', title: 'Selection <&>', publishedAt: '2026-11-12' }] },
      { id: 'two', title: 'Unselected channel' }
    ] },
    analytics: { channels: {
      one: { data: { from:'2026-10-15', through:'2026-11-11', days:28, totals:{estimatedMinutesWatched:4500}, warnings:['Selected coverage'] } },
      two: { data: { warnings:['Other channel private data'] } }
    } }
  };
  const { filename, html } = reportDocument(store, { source:'youtube', channelId:'one' });
  assert.match(filename, /^YouTube-บันทึก/);
  assert.match(html, /Selection &lt;&amp;&gt;/);
  assert.match(html, /Selected coverage/);
  assert.match(html, /Watch hours<\/span><b>75</);
  assert.doesNotMatch(html, /<script>|Unselected channel|Other channel private data/);
  assert.throws(() => reportDocument(store, { source:'youtube',channelId:'wrong' }));
});

test('Apple report preserves selected dates, currency, ranking, refunds and incomplete coverage', () => {
  const app = (title, paidDownloads, thb, prior) => ({
    title, paidDownloads, previousPaidDownloads:0, freeDownloads:0, inAppPurchases:0,
    proceeds:{ THB:thb, USD:1234 }, previousProceeds:{ THB:prior, USD:1234 }
  });
  const data = { days:30, from:'2026-10-16', through:'2026-11-14', comparisonFrom:'2026-09-16',
    reportedDays:30, comparisonReportedDays:30, missingDays:[], complete:true,
    apps:[app('A refunds',8,-3,10),app('B gains',2,10,2)] };
  const options = { source:'apple', days:30, currency:'THB', order:'proceeds' };
  const { html, filename } = reportDocument({},options,data);
  assert.match(filename, /30d-2026-11-14/);
  assert.ok(html.indexOf('B gains') < html.indexOf('A refunds'));
  assert.match(html, /Proceeds in THB/);
  assert.doesNotMatch(html, /1,234|USD/);
  const partial = reportDocument({}, { ...options, order:'paidDownloads' }, { ...data, reportedDays:29, complete:false, missingDays:['2026-10-16'] });
  assert.ok(partial.html.indexOf('A refunds') < partial.html.indexOf('B gains'));
  assert.match(partial.html, /Partial report/);
  assert.match(partial.html, /Unavailable report dates/);
  assert.doesNotMatch(partial.html, /<td>\+8<\/td>/);
});
