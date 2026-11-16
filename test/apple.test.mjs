import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { getSales } from '../apple.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentials = { issuerId: 'team', vendorNumber: '80000001', keyId: 'key', privateKey };
const now = new Date('2026-11-16T18:00:00Z');
const columns = 'SKU\tTitle\tParent Identifier\tProduct Type Identifier\tUnits\tCustomer Price\tDeveloper Proceeds\tCurrency of Proceeds\tBegin Date\tEnd Date';

function dailyResponse(day, rows = []) {
  const [year, month, date] = day.split('-');
  const ptDate = [month, date, year].join('/');
  const lines = rows.map(row => [...row, ptDate, ptDate].join('\t'));
  return new Response(gzipSync([columns, ...lines, ''].join('\r\n')));
}

function requestDay(url) {
  assert.equal(url.origin, 'https://api.appstoreconnect.apple.com');
  assert.equal(url.searchParams.get('filter[reportType]'), 'SALES');
  return url.searchParams.get('filter[reportDate]');
}

function notFound(detail) {
  return Response.json({ errors: [{ code: 'NOT_FOUND', detail }] }, { status: 404 });
}

test('groups purchases by app SKU, nets refunds, compares seven PT dates and keeps currencies separate', async () => {
  const rows = {
    '2026-11-02': [
      ['OLD', 'Old app', '', 'F1', '3', '8.00', '6.80', 'USD'],
      ['APP', 'Early name', '', '1F', '4', '1.99', '1.40', 'USD']
    ],
    '2026-11-09': [
      ['coins', 'Coins pack', 'APP', 'IA1', '5', '1.99', '1.40', 'CAD'],
      ['trial', 'Monthly trial', 'APP', 'IAY', '7', '0', '0', 'USD'],
      ['restore', 'Restore', 'APP', 'IA3', '20', '0', '0', 'USD'],
      ['APP', 'Final name', '', '1F', '10', '1.99', '1.40', 'USD'],
      ['APP', 'Final name', '', '1F', '-2', '-1.99', '1.40', 'USD'],
      ['FREE', 'Free app', '', 'F1', '3', '0', '0', 'USD'],
      ['FREE', 'Free app', '', 'F7', '500', '0', '0', 'USD'],
      ['FREE', 'Free app', '', '3F', '55', '0', '0', 'USD']
    ],
    '2026-11-15': [
      ['monthly', 'Monthly membership', 'APP', '1AY', '3', '7.99', '5.60', 'USD'],
      ['monthly', 'Monthly membership', 'APP', '1AY', '-1', '-7.99', '5.60', 'USD']
    ]
  };
  const fetchImpl = async (url, options) => {
    const day = requestDay(url);
    const [scheme, jwt] = options.headers.Authorization.split(' ');
    const [header, claims, signature] = jwt.split('.');
    assert.equal(scheme, 'Bearer');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, credentials.issuerId);
    assert.ok(verify('sha256', Buffer.from(header + '.' + claims),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
    return dailyResponse(day, rows[day]);
  };
  const result = await getSales(credentials, null, { now, fetchImpl });
  assert.equal(result.through, '2026-11-15');
  assert.equal(result.from, '2026-11-09');
  assert.equal(result.comparisonFrom, '2026-11-02');
  assert.equal(result.complete, true);
  assert.equal(result.reportedDays, 7);
  assert.equal(result.comparisonReportedDays, 7);
  const [app] = result.apps;
  assert.deepEqual(app, {
    id: 'APP', title: 'Final name', paidDownloads: 8, inAppPurchases: 7, freeDownloads: 0,
    proceeds: { CAD: 7, USD: 22.4 }, previousProceeds: { USD: 5.6 },
    previousPaidDownloads: 4, previousFreeDownloads: 0, previousInAppPurchases: 0
  });
  assert.equal(result.apps.find(a => a.id === 'OLD').previousPaidDownloads, 3);
  assert.equal(result.apps.find(a => a.id === 'FREE').freeDownloads, 3);
  const cached = await getSales(credentials, JSON.parse(JSON.stringify(result.cache)), {
    now, fetchImpl: () => assert.fail('completed reports should be served from the cache')
  });
  assert.deepEqual(cached, result);
});

test('keeps missing reports distinct from explicit zero sales and backfills new and unconfirmed days', async () => {
  const result = await getSales(credentials, null, {
    now, fetchImpl: async url => {
      const day = requestDay(url);
      if (day === '2026-11-15') return notFound('Report is not available yet.');
      if (day === '2026-11-14' || day === '2026-11-02') return notFound('There were no sales for the date specified.');
      return dailyResponse(day);
    }
  });
  assert.deepEqual(result.missingDays, ['2026-11-15']);
  assert.equal(result.complete, false);
  assert.equal(result.reportedDays, 6);
  assert.match(result.warning, /6 of 7/);
  const fetched = [];
  const next = await getSales(credentials, result.cache, {
    now: new Date('2026-11-17T18:00:00Z'), fetchImpl: async url => {
      const day = requestDay(url);
      fetched.push(day);
      return dailyResponse(day);
    }
  });
  assert.deepEqual(fetched.sort(), ['2026-11-14', '2026-11-15', '2026-11-16']);
  assert.equal(next.complete, true);
});

test('uses the scheduled 8am Pacific release boundary including daylight saving time', async () => {
  for (const [clock, expected] of [
    ['2026-11-16T15:59:59Z', '2026-11-14'], ['2026-11-16T16:00:00Z', '2026-11-15'],
    ['2026-07-01T14:59:59Z', '2026-06-29'], ['2026-07-01T15:00:00Z', '2026-06-30']
  ]) {
    const result = await getSales(credentials, null, {
      now: new Date(clock), fetchImpl: async () => notFound('Report is not available yet.')
    });
    assert.equal(result.through, expected);
    assert.equal(result.missingDays.length, 14);
    assert.equal(result.reportedDays, 0);
    assert.equal(result.complete, false);
  }
});

test('reports unreadable or wrong-date files as holes and retries; validates provider access', async () => {
  const bad = await getSales(credentials, null, { now, fetchImpl: async url => dailyResponse(
    '1999-01-01', [['APP', 'A', '', '1F', '3', '1.99', '1.40', 'USD']]
  ) });
  assert.equal(bad.complete, false);
  assert.equal(bad.missingDays.length, 14);
  assert.equal(Object.keys(bad.cache.reports).length, 0);
  assert.match(bad.warning, /report date/);
  for (const status of [400, 401, 403, 429, 503]) {
    await assert.rejects(getSales(credentials, null, {
      now, fetchImpl: () => new Response(null, { status })
    }), new RegExp('HTTP ' + status));
  }
});

test('uses a fresh cache when the selected Apple team or vendor changes', async () => {
  const initial = await getSales(credentials, null, { now, fetchImpl: async url => dailyResponse(requestDay(url)) });
  let count = 0;
  await getSales({ ...credentials, vendorNumber: '777' }, initial.cache, {
    now, fetchImpl: async url => { count++; return dailyResponse(requestDay(url)); }
  });
  assert.equal(count, 14);
});

test('backfills 90 days plus their comparison with bounded concurrency and reuses the cache across period switches', async () => {
  const fetched = new Set();
  let active = 0, peak = 0;
  const fetchImpl = async url => {
    const day = requestDay(url);
    assert.ok(!fetched.has(day), 'repeat request for ' + day);
    fetched.add(day);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    const units = day >= '2026-08-18' ? '1' : '2';
    return dailyResponse(day, [['APP', 'App', '', '1F', units, '1.99', '1.40', 'USD']]);
  };
  const initial = await getSales(credentials, null, { now, fetchImpl });
  // The installed seven-day cache predates period filters.
  const legacy = { version: 1, owner: initial.cache.owner, reports: initial.cache.reports };
  const full = await getSales(credentials, legacy, { days: 90, now, fetchImpl });
  assert.equal(fetched.size, 180);
  assert.ok(peak > 1 && peak <= 4);
  assert.equal(full.days, 90);
  assert.equal(full.from, '2026-08-18');
  assert.equal(full.comparisonFrom, '2026-05-20');
  assert.equal(full.through, '2026-11-15');
  assert.equal(full.reportedDays, 90);
  assert.equal(full.comparisonReportedDays, 90);
  assert.equal(full.apps[0].paidDownloads, 90);
  assert.equal(full.apps[0].previousPaidDownloads, 180);
  let cache = full.cache;
  for (const days of [1, 30, 7, 90]) {
    const report = await getSales(credentials, cache, { now, fetchImpl, days });
    assert.equal(report.days, days);
    assert.equal(report.apps[0].paidDownloads, days);
    assert.equal(report.complete, true);
    assert.equal(Object.keys(report.cache.reports).length, 180);
    cache = report.cache;
  }
  assert.equal(fetched.size, 180);
  const tomorrow = await getSales(credentials, cache, { now: new Date('2026-11-17T18:00:00Z'), fetchImpl });
  assert.equal(fetched.size, 181);
  assert.equal(tomorrow.days, 7);
  assert.equal(Object.keys(tomorrow.cache.reports).length, 180);
  assert.ok(!tomorrow.cache.reports['2026-05-20']);
});

test('preserves historical backfill progress after a rate limit, retries gaps, and rejects invalid access and periods', async () => {
  let count = 0;
  const partial = await getSales(credentials, null, { now, days: 30, fetchImpl: async url => {
    if (++count > 8) return new Response(null, { status: 429 });
    return dailyResponse(requestDay(url));
  } });
  assert.equal(count, 12);
  assert.equal(partial.complete, false);
  assert.equal(partial.reportedDays, 8);
  assert.equal(partial.comparisonReportedDays, 0);
  assert.equal(partial.missingDays.length, 52);
  assert.match(partial.warning, /429/);
  const recovered = await getSales(credentials, partial.cache, { now, days: 30, fetchImpl: async url => {
    assert.ok(partial.missingDays.includes(requestDay(url)));
    return dailyResponse(requestDay(url));
  } });
  assert.equal(recovered.complete, true);
  await assert.rejects(getSales(credentials, partial.cache, {
    now, days: 90, fetchImpl: async () => new Response(null, { status: 403 })
  }), /403/);
  for (const days of [0, 2, 29, 91, '7', null]) {
    await assert.rejects(getSales(credentials, null, { now, days, fetchImpl: () => assert.fail() }), /period/);
  }
});
