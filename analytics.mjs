import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { keychain } from './keychain.mjs';
import { address, support } from './paths.mjs';

const scopes = ['youtube.readonly', 'yt-analytics.readonly'].map(name => 'https://www.googleapis.com/auth/' + name);
const metrics = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost'];
const breakdownMetrics = ['views', 'estimatedMinutesWatched'];
const idPattern = /^UC[A-Za-z0-9_-]{22}$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const hour = 3600000;
const emptyChannel = () => ({ connected: false, updatedAt: null, error: null, data: null });

class AnalyticsError extends Error {}
function safeError(error) {
  return error instanceof AnalyticsError ? error : new AnalyticsError('Could not read or save YouTube Analytics. Check your network connection, account credential store, and disk space.');
}

function shiftDay(day, delta) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

async function request(fetchImpl, url, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch {
    throw new AnalyticsError('Could not reach Google. Check your network connection.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (url === 'https://oauth2.googleapis.com/token' && data?.error === 'invalid_grant') {
      const error = new AnalyticsError('Google authorization expired or was revoked. Connect this channel again.');
      error.invalidGrant = true;
      throw error;
    }
    if (response.status === 403) throw new AnalyticsError('Google denied access. Check API enablement, channel ownership, read-only permissions, and quota.');
    throw new AnalyticsError('Google returned HTTP ' + response.status + '. Check the OAuth configuration or try again later.');
  }
  if (!data || typeof data !== 'object') throw new AnalyticsError('Google returned an unreadable response.');
  return data;
}

async function tokenRequest(fetchImpl, client, fields) {
  const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...fields });
  const result = await request(fetchImpl, 'https://oauth2.googleapis.com/token', { method: 'POST', body });
  if (typeof result.access_token !== 'string' || !result.access_token) throw new AnalyticsError('Google did not issue an access token.');
  if (result.scope && !scopes.every(scope => result.scope.split(' ').includes(scope))) {
    throw new AnalyticsError('Both read-only YouTube permissions are needed. Connect again and select both.');
  }
  return result;
}

async function reports(channelId, accessToken, time, fetchImpl) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  async function query(from, through, measures, dimension, sort, limit) {
    const url = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    url.search = new URLSearchParams({ ids: 'channel==' + channelId, startDate: from, endDate: through, metrics: measures.join(',') });
    if (dimension) url.searchParams.set('dimensions', dimension);
    if (sort) url.searchParams.set('sort', sort);
    if (limit) url.searchParams.set('maxResults', limit);
    const result = await request(fetchImpl, url, { headers });
    const names = result.columnHeaders?.map(col => col.name);
    const fields = dimension ? [dimension, ...measures] : measures;
    if (!names || !fields.every(name => names.includes(name)) || (result.rows !== undefined && !Array.isArray(result.rows))) {
      throw new AnalyticsError('YouTube returned incomplete analytics columns.');
    }
    return (result.rows ?? []).map(row => {
      const values = {};
      for (const name of fields) {
        const value = row[names.indexOf(name)];
        if (name === dimension ? typeof value !== 'string' : typeof value !== 'number' || !Number.isFinite(value)) {
          throw new AnalyticsError('YouTube returned an unreadable analytics value.');
        }
        values[name] = value;
      }
      return values;
    });
  }

  const today = pacific.format(time);
  const recent = await query(shiftDay(today, -55), today, metrics, 'day', 'day', 56);
  if (recent.some(row => !dayPattern.test(row.day) || row.day > today)) throw new AnalyticsError('YouTube returned an unreadable report date.');
  recent.sort((a, b) => a.day.localeCompare(b.day));
  if (!recent.length) {
    return { from: null, through: null, days: 0, daily: [], trafficSources: [], countries: [],
      totals: Object.fromEntries(metrics.map(name => [name, null])), warnings: ['YouTube returned no daily activity in the past 56 days.'] };
  }
  const through = recent.at(-1).day;
  const from = shiftDay(through, -27);
  const dailyRows = from < shiftDay(today, -55) ? await query(from, through, metrics, 'day', 'day', 28) : recent.filter(row => row.day >= from);
  const daily = dailyRows.map(({ day, ...values }) => ({ date: day, ...values }));
  // Request totals directly: YouTube computes average duration over views across the entire range.
  const [totalsRows, traffic, geo] = await Promise.all([
    query(from, through, metrics),
    query(from, through, breakdownMetrics, 'insightTrafficSourceType', '-views', 25).catch(() => null),
    query(from, through, breakdownMetrics, 'country', '-views', 10).catch(() => null),
  ]);
  if (!totalsRows.length) throw new AnalyticsError('YouTube has not provided the period totals yet. Try again later.');
  const warnings = [];
  if (!traffic?.length) warnings.push('Traffic-source breakdown unavailable for this period.');
  if (!geo?.length) warnings.push('Country breakdown unavailable for this period.');
  if (daily.length < 28) warnings.push('YouTube reported activity for ' + daily.length + ' of the 28 calendar days.');
  return { from, through, days: 28, totals: totalsRows[0], daily,
    trafficSources: (traffic ?? []).map(({ insightTrafficSourceType, ...values }) => ({ source: insightTrafficSourceType, ...values })),
    countries: geo ?? [], warnings };
}

export async function createAnalytics({ dir = support, vault = keychain, fetchImpl = fetch, now = () => new Date(), redirectUri = () => address } = {}) {
  const folder = path.join(dir, 'analytics');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const records = new Map();
  const busy = new Set();
  const pending = new Map();
  const files = await readdir(folder);
  let clientConfigured = files.includes('client.json');
  let settingClient = false;
  for (const filename of files) {
    const id = filename.replace(/\.json$/, '');
    if (!idPattern.test(id) || filename !== id + '.json') continue;
    try {
      const value = JSON.parse(await readFile(path.join(folder, filename), 'utf8'));
      if (typeof value.connected !== 'boolean') throw new Error();
      records.set(id, value);
    } catch { throw new AnalyticsError('Cannot read the saved YouTube Analytics data in the dashboard’s data folder.'); }
  }
  async function save(name, value) {
    const target = path.join(folder, name + '.json');
    const temp = target + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, target);
    if (idPattern.test(name)) records.set(name, value);
  }

  const clientAccount = 'analytics-desktop-client';
  const grantAccount = id => 'analytics-grant-' + id;
  async function load(account) {
    try { return JSON.parse(await vault('get', account)); }
    catch { throw new AnalyticsError('Cannot read the saved Google credentials. Unlock your account or reconnect in the dashboard.'); }
  }
  function validId(id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new AnalyticsError('Choose a valid YouTube channel.');
  }
  function state(channelIds = []) {
    const channels = {};
    for (const id of channelIds.filter(value => idPattern.test(value))) {
      const { connected, updatedAt, error, data } = records.get(id) ?? emptyChannel();
      const expired = data && now() - Date.parse(updatedAt) >= 30 * 24 * hour;
      channels[id] = { connected, updatedAt, error, data: expired ? null : data };
    }
    return { clientConfigured, channels };
  }
  async function setClient({ clientId, clientSecret }) {
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId.trim()) ||
        typeof clientSecret !== 'string' || !clientSecret.trim() || clientSecret.length > 1024) {
      throw new AnalyticsError('Enter the client ID and client secret from a Google Desktop app OAuth client.');
    }
    if (settingClient) throw new AnalyticsError('Google client setup is already in progress.');
    settingClient = true;
    try {
      await vault('set', clientAccount, JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }));
      await save('client', { configured: true });
      clientConfigured = true;
      pending.clear();
    } catch (error) { throw safeError(error); }
    finally { settingClient = false; }
  }

  async function begin(channelId) {
    validId(channelId);
    if (!clientConfigured) throw new AnalyticsError('Set up the Google Desktop app client first.');
    const client = await load(clientAccount);
    const time = +now();
    // Only the most recent outstanding login for a channel can complete.
    for (const [key, item] of pending) if (item.channelId === channelId || item.expires <= time) pending.delete(key);
    const stateKey = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const callbackUri = redirectUri();
    pending.set(stateKey, { channelId, verifier, client, callbackUri, expires: time + 10 * 60000 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: client.clientId, redirect_uri: callbackUri, response_type: 'code', scope: scopes.join(' '),
      state: stateKey, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      access_type: 'offline', prompt: 'select_account consent',
    });
    return url.href;
  }

  async function updateReport(id, accessToken) {
    const record = records.get(id);
    const updatedAt = now().toISOString();
    const data = await reports(id, accessToken, now(), fetchImpl);
    await save(id, { ...record, connected: true, data, updatedAt, attemptedAt: updatedAt, error: null });
  }
  async function fail(id, rawError) {
    const error = safeError(rawError);
    const previous = records.get(id);
    const retained = error.invalidGrant ? emptyChannel() : previous;
    await save(id, { ...retained, attemptedAt: now().toISOString(), error: error.message });
    if (error.invalidGrant) await vault('delete', grantAccount(id)).catch(() => {});
    return error;
  }
  async function callback(params, allowedIds) {
    const key = params.get('state');
    const attempt = pending.get(key);
    pending.delete(key);
    if (!attempt || attempt.expires <= +now()) throw new AnalyticsError('This sign-in request expired or was already used. Connect the channel again.');
    const { channelId: id, client, verifier, callbackUri } = attempt;
    const ensureAllowed = () => {
      const allowed = typeof allowedIds === 'function' ? allowedIds() : allowedIds;
      if (allowed && !allowed.includes(id)) throw new AnalyticsError('This channel is no longer configured in the dashboard.');
    };
    ensureAllowed();
    if (params.has('error') || !params.get('code')) throw new AnalyticsError('Google sign-in did not finish. Connect again when ready.');
    if (busy.has(id)) throw new AnalyticsError('A channel refresh is already running. Connect again after it finishes.');
    busy.add(id);
    try {
      const token = await tokenRequest(fetchImpl, client, { grant_type: 'authorization_code', code: params.get('code'), redirect_uri: callbackUri, code_verifier: verifier });
      const mine = new URL('https://www.googleapis.com/youtube/v3/channels');
      mine.search = new URLSearchParams({ part: 'id', mine: 'true', fields: 'items/id', maxResults: '50' });
      const identity = await request(fetchImpl, mine, { headers: { Authorization: 'Bearer ' + token.access_token } });
      if (!identity.items?.some(item => item.id === id)) throw new AnalyticsError('Google authorized a different YouTube channel. Connect again and select the matching channel or Brand Account.');
      if (!token.refresh_token) throw new AnalyticsError('Google did not grant offline access. Connect this channel again and approve both permissions.');
      ensureAllowed();
      // Keep the issuing client paired with each channel even when setup changes for later grants.
      await vault('set', grantAccount(id), JSON.stringify({ ...client, refreshToken: token.refresh_token }));
      await save(id, { ...(records.get(id) ?? emptyChannel()), connected: true, error: null });
      try { await updateReport(id, token.access_token); }
      catch (error) { await fail(id, error); } // Consent succeeded. A reporting outage can be retried.
      return id;
    } catch (error) { throw safeError(error); }
    finally { busy.delete(id); }
  }

  async function refresh(id) {
    validId(id);
    if (!records.get(id)?.connected) throw new AnalyticsError('Connect this channel to YouTube Analytics first.');
    if (busy.has(id)) throw new AnalyticsError('A refresh is already running for this channel.');
    busy.add(id);
    try {
      const grant = await load(grantAccount(id));
      const token = await tokenRequest(fetchImpl, grant, { grant_type: 'refresh_token', refresh_token: grant.refreshToken });
      if (token.refresh_token && token.refresh_token !== grant.refreshToken) {
        await vault('set', grantAccount(id), JSON.stringify({ ...grant, refreshToken: token.refresh_token }));
      }
      await updateReport(id, token.access_token);
    } catch (error) { throw await fail(id, error); }
    finally { busy.delete(id); }
  }

  async function tick(channelIds = []) {
    const current = +now();
    await Promise.all([...records].map(async ([id, value]) => {
      if (busy.has(id)) return;
      if (value.data && current - Date.parse(value.updatedAt) >= 30 * 24 * hour) {
        busy.add(id);
        try { await save(id, { ...value, data: null }); }
        finally { busy.delete(id); }
      }
      const interval = value.error ? hour : 6 * hour;
      if (channelIds.includes(id) && value.connected && (!value.attemptedAt || current - Date.parse(value.attemptedAt) >= interval)) {
        await refresh(id).catch(() => {}); // The channel's own error is saved for the dashboard.
      }
    }));
  }

  return { state, setClient, begin, callback, refresh, tick };
}
