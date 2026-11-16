import { createHash, sign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const appTypes = new Set(['1', '1-B', 'F1-B', '1E', '1EP', '1EU', '1F', '1T', 'F1']);
const purchaseTypes = new Set(['FI1', 'IA1', 'IA1-M', 'IA9', 'IA9-M', 'IAY', 'IAY-M', '1AY']);
const pacificTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23'
});

function shiftDay(day, offset) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

// Read the already-cached reports for the displayed week, including refunds.
// An absent report is a gap even when another date in the week had no sales.
export function dailyPaidDownloads(report, cache) {
  const daily = [];
  if (!report || ![report.from, report.through].every(day => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)))) return daily;
  const missing = new Set(report.missingDays ?? []);
  for (let offset = -6; offset <= 0; offset++) {
    const date = shiftDay(report.through, offset);
    if (date < report.from) continue;
    const day = cache?.version === 1 && !missing.has(date) ? cache.reports?.[date] : null;
    let paidDownloads = null;
    if (day?.noSales) paidDownloads = 0;
    else if (Array.isArray(day?.apps) && day.apps.every(app => Number.isSafeInteger(app?.paidDownloads))) {
      paidDownloads = day.apps.reduce((total, app) => total + app.paidDownloads, 0);
    }
    daily.push({ date, paidDownloads });
  }
  return daily;
}

export function latestAppleReportDate(now) {
  const parts = Object.fromEntries(pacificTime.formatToParts(now).map(p => [p.type, p.value]));
  const today = [parts.year, parts.month, parts.day].join('-');
  return shiftDay(today, Number(parts.hour) >= 8 ? -1 : -2);
}

const periods = [1, 7, 30, 90];

export function validateApplePeriod(days) {
  if (!periods.includes(days)) throw new Error('Choose an Apple reporting period of 1, 7, 30 or 90 days.');
}

function bearerToken({ keyId, issuerId, privateKey }, now) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issued = Math.floor(now.getTime() / 1000);
  const header = encode({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const claims = encode({ iss: issuerId, iat: issued, exp: issued + 900, aud: 'appstoreconnect-v1' });
  const unsigned = header + '.' + claims;
  try {
    const signature = sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return unsigned + '.' + signature.toString('base64url');
  } catch {
    throw new Error('Unable to sign the Apple request. Choose the .p8 file for your team API key.');
  }
}

function numberField(value, column) {
  if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    throw new Error('Unreadable ' + column + ' in the sales report.');
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid number in the sales report.');
  return number;
}

function newApp(id) {
  return { id, title: '', paidDownloads: 0, freeDownloads: 0, inAppPurchases: 0, proceeds: {} };
}

function addProceeds(totals, currency, amount) {
  totals[currency] = Number(((totals[currency] ?? 0) + amount).toFixed(6));
}

function parseReport(bytes, day) {
  const data = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 })
    : bytes;
  const lines = data.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const headers = lines.shift().split('\t').map(name => name.trim().toLowerCase());
  const column = name => {
    const index = headers.indexOf(name);
    if (index === -1) throw new Error('Missing column ' + name + ' in the sales report.');
    return index;
  };
  const sku = column('sku'), title = column('title'), parent = column('parent identifier');
  const type = column('product type identifier'), units = column('units'), price = column('customer price');
  const currency = column('currency of proceeds');
  const proceeds = headers.includes('developer proceeds (per unit)')
    ? column('developer proceeds (per unit)') : column('developer proceeds');
  const start = column('begin date'), end = column('end date');
  const [year, month, date] = day.split('-');
  const expectedDate = [month, date, year].join('/');
  const apps = new Map();
  for (const line of lines) {
    if (line.trim() === '') continue;
    const fields = line.split('\t').map(value => value.trim());
    if (fields.length < Math.max(sku, title, parent, type, units, price, currency, proceeds, start, end) + 1 ||
        fields[start] !== expectedDate || fields[end] !== expectedDate) {
      throw new Error('Unexpected row or report date in the sales report.');
    }
    const product = fields[type];
    const isPurchase = purchaseTypes.has(product);
    const isRestore = /^(?:IA|FI)3(?:-M)?$/.test(product);
    const isUpdateOrRedownload = /^(?:F)?[37][A-Z]*(?:-B)?$/.test(product);
    if (isRestore) continue;
    if (!appTypes.has(product) && !isPurchase && !isUpdateOrRedownload) {
      throw new Error('Unrecognized product type in the sales report.');
    }
    const id = isPurchase ? fields[parent] : fields[sku];
    if (!id) throw new Error('Missing app SKU in the sales report.');
    const app = apps.get(id) ?? newApp(id);
    apps.set(id, app);
    if (!isPurchase && fields[title]) app.title = fields[title];
    if (isUpdateOrRedownload) continue;

    const quantity = numberField(fields[units], 'units');
    const customerPrice = numberField(fields[price], 'customer price');
    const perUnit = numberField(fields[proceeds], 'developer proceeds');
    if (quantity === 0 && perUnit !== 0) {
      // Apple can report partial refunds with zero units and an ambiguous per-unit adjustment.
      throw new Error('Zero-unit proceeds adjustment requires review in App Store Connect.');
    }
    if (isPurchase) {
      if (customerPrice !== 0) app.inAppPurchases += quantity;
    } else if (customerPrice !== 0) {
      app.paidDownloads += quantity;
    } else {
      app.freeDownloads += quantity;
    }
    if (perUnit !== 0) {
      const code = fields[currency].toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) throw new Error('Unreadable proceeds currency in the sales report.');
      addProceeds(app.proceeds, code, quantity * perUnit);
    }
  }
  return [...apps.values()];
}

function temporaryError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

async function downloadDay(vendor, token, day, fetchImpl, deadline) {
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(20000)]);
  const url = new URL('https://api.appstoreconnect.apple.com/v1/salesReports');
  for (const [key, value] of Object.entries({
    vendorNumber: vendor, reportType: 'SALES', reportSubType: 'SUMMARY', frequency: 'DAILY',
    version: '1_0', reportDate: day
  })) url.searchParams.set('filter[' + key + ']', value);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/a-gzip' },
      signal, redirect: 'error'
    });
  } catch {
    throw temporaryError('Could not reach App Store Connect. Check the connection and refresh again.');
  }
  if (response.status === 404) {
    const error = await response.json().catch(() => null);
    const detail = error?.errors?.[0]?.detail ?? '';
    if (/^There were no sales for the date specified\.?$/i.test(detail.trim())) return { noSales: true, apps: [] };
    return { problem: 'Report unavailable' };
  }
  if (!response.ok) {
    const hint = {
      400: 'Check the vendor number and team settings.',
      401: 'Check that the issuer ID, key ID and .p8 file belong to the same active team key.',
      403: 'Check team key access to Sales and Reports and any pending Apple agreements.',
      429: 'Apple has limited requests. Try again later.'
    };
    const message = 'App Store Connect returned HTTP ' + response.status + '. ' +
      (hint[response.status] ?? 'Check the vendor number and try again later.');
    throw response.status === 429 || response.status >= 500 ? temporaryError(message) : new Error(message);
  }
  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    return { apps: parseReport(bytes, day) };
  } catch (error) {
    if (signal.aborted) throw temporaryError('Apple took too long to deliver the report.');
    const knownMessage = /sales report\.|requires review in App Store Connect\.$/.test(error.message);
    return { problem: knownMessage ? error.message : 'Unreadable sales report' };
  }
}

function combine(dates, period, reports) {
  const apps = new Map();
  for (const [index, day] of dates.entries()) {
    for (const daily of reports[day]?.apps ?? []) {
      const app = apps.get(daily.id) ?? {
        ...newApp(daily.id), previousProceeds: {}, previousPaidDownloads: 0,
        previousFreeDownloads: 0, previousInAppPurchases: 0
      };
      apps.set(daily.id, app);
      if (daily.title) app.title = daily.title;
      const current = index >= period;
      for (const [code, amount] of Object.entries(daily.proceeds)) {
        addProceeds(current ? app.proceeds : app.previousProceeds, code, amount);
      }
      if (current) {
        app.paidDownloads += daily.paidDownloads;
        app.freeDownloads += daily.freeDownloads;
        app.inAppPurchases += daily.inAppPurchases;
      } else {
        app.previousPaidDownloads += daily.paidDownloads;
        app.previousFreeDownloads += daily.freeDownloads;
        app.previousInAppPurchases += daily.inAppPurchases;
      }
    }
  }
  for (const app of apps.values()) app.title ||= app.id;
  return [...apps.values()].sort((a, b) =>
    (b.paidDownloads + b.inAppPurchases) - (a.paidDownloads + a.inAppPurchases) ||
    a.title.localeCompare(b.title));
}

export async function getSales(credentials, previousCache = null, { fetchImpl = fetch, now = new Date(), days = 7 } = {}) {
  validateApplePeriod(days);
  const { keyId, issuerId, vendorNumber, privateKey } = credentials;
  if (!keyId || !issuerId || !vendorNumber || !privateKey) throw new Error('Apple team key details are incomplete.');
  const token = bearerToken(credentials, now);
  const owner = createHash('sha256').update(JSON.stringify([issuerId, String(vendorNumber)])).digest('hex');
  const through = latestAppleReportDate(now);
  const dates = Array.from({ length: days * 2 }, (_, index) => shiftDay(through, 1 + index - days * 2));

  // Keep all dates a supported period can reuse, including when a daily seven-day sync follows a long backfill.
  const reports = {};
  const issues = {};
  const oldest = shiftDay(through, 1 - 2 * Math.max(...periods));
  if (previousCache?.version === 1 && previousCache.owner === owner) {
    for (const [day, data] of Object.entries(previousCache.reports)) {
      if (day >= oldest && day <= through) reports[day] = data;
    }
    for (const [day, issue] of Object.entries(previousCache.issues ?? {})) {
      if (day >= oldest && day <= through) issues[day] = issue;
    }
  }
  const pending = dates.filter(day => {
    const cached = reports[day];
    if (!cached) return true;
    if (!cached.noSales || cached.confirmedThrough >= shiftDay(day, 3)) return false;
    // Recheck provisional empty dates on a later sync, without repeating requests on each filter change.
    return !cached.checkedAt || now.getTime() - cached.checkedAt >= 3 * 60 * 60 * 1000;
  }).reverse();
  // Always work through previously unattempted dates before retrying a known gap.
  pending.sort((a, b) => (issues[a]?.checkedAt ?? 0) - (issues[b]?.checkedAt ?? 0));

  const reasons = new Set();
  const deadline = AbortSignal.timeout(60000);
  const batchSize = 4;
  for (let start = 0; start < pending.length; start += batchSize) {
    if (deadline.aborted) {
      reasons.add('Backfill time limit reached. Refresh this period to continue');
      break;
    }
    const batch = pending.slice(start, start + batchSize);
    const results = await Promise.allSettled(batch.map(day => downloadDay(vendorNumber, token, day, fetchImpl, deadline)));
    let interrupted;
    for (const [index, result] of results.entries()) {
      const day = batch[index];
      if (result.status === 'rejected') {
        if (!result.reason.retryable || days <= 7) throw result.reason;
        interrupted = result.reason;
        continue;
      }
      const daily = result.value;
      if (daily.problem) {
        delete reports[day];
        issues[day] = { message: daily.problem, checkedAt: now.getTime() };
      } else {
        delete issues[day];
        if (daily.noSales) {
          daily.checkedAt = now.getTime();
          daily.confirmedThrough = through;
        }
        reports[day] = daily;
      }
    }
    if (interrupted) {
      if (!dates.some(day => reports[day])) throw interrupted;
      reasons.add(interrupted.message + ' Refresh this period to continue');
      break;
    }
  }
  const missingDays = dates.filter(day => !reports[day]);
  for (const day of missingDays) {
    if (issues[day]) reasons.add(issues[day].message);
  }
  const reportedDays = dates.slice(days).filter(day => reports[day]).length;
  const comparisonReportedDays = dates.slice(0, days).filter(day => reports[day]).length;
  let warning = null;
  if (missingDays.length || reasons.size) {
    const summary = missingDays.length <= 5 ? missingDays.join(', ') : missingDays.length + ' dates';
    const parts = [];
    if (summary) parts.push('Missing Apple reports for ' + summary + '.');
    for (const reason of reasons) parts.push(reason.replace(/\.$/, '') + '.');
    if (reportedDays < days) parts.push('Current totals cover ' + reportedDays + ' of ' + days + ' days.');
    if (missingDays.length) parts.push('The comparison is incomplete.');
    warning = parts.join(' ');
  }
  return {
    days, from: dates[days], through, comparisonFrom: dates[0], apps: combine(dates, days, reports),
    complete: missingDays.length === 0, missingDays, warning, reportedDays, comparisonReportedDays,
    cache: { version: 1, owner, reports, issues }
  };
}
