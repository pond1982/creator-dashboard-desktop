import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnalytics } from '../analytics.mjs';

const id = 'UC' + 'a'.repeat(22);
const other = 'UC' + 'b'.repeat(22);
const client = { clientId: 'test-app.apps.googleusercontent.com', clientSecret: 'sensitive-client' };
const expected = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost'];
const secrets = [client.clientSecret, 'sensitive-access', 'sensitive-refresh', 'sensitive-rotated', 'sensitive-code'];

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'creator-analytics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let time = new Date('2026-11-16T08:30:00Z');
  const entries = new Map();
  const calls = [];
  const sim = { identity: id, optionalFails: false, reportFails: false, noData: false, revoked: false, rotate: false };
  const deps = {
    dir, now: () => new Date(time),
    vault: async (op, name, value) => {
      if (op === 'set') entries.set(name, value);
      else if (op === 'get' && entries.has(name)) return entries.get(name);
      else if (op === 'delete') entries.delete(name);
      else throw new Error('secret-keychain-error-' + secrets[0]);
    },
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      const p = url.searchParams;
      calls.push({ url, options });
      if (url.hostname === 'oauth2.googleapis.com') {
        assert.equal(options.body.get('client_secret'), client.clientSecret);
        assert.equal(options.method, 'POST');
        if (sim.revoked) return Response.json({ error: 'invalid_grant', error_description: secrets[0] }, { status: 400 });
        const grant = options.body.get('grant_type');
        return Response.json({ access_token: 'sensitive-access',
          refresh_token: grant === 'authorization_code' ? 'sensitive-refresh' : sim.rotate ? 'sensitive-rotated' : undefined });
      }
      assert.equal(options.headers.Authorization, 'Bearer sensitive-access');
      if (url.hostname === 'www.googleapis.com') {
        assert.equal(p.get('mine'), 'true');
        return Response.json({ items: [{ id: sim.identity }] });
      }
      assert.equal(url.hostname, 'youtubeanalytics.googleapis.com');
      const dimension = p.get('dimensions');
      assert.equal(p.get('ids'), 'channel==' + id);
      if (sim.reportFails || (sim.optionalFails && dimension === 'country')) {
        return Response.json({ error: { message: secrets[0] } }, { status: 503 });
      }
      const names = p.get('metrics').split(',');
      if (dimension) names.push(dimension);
      names.reverse(); // Real responses identify columns by header name, never a hardcoded positional index.
      const sample = { views: 100, estimatedMinutesWatched: 25.5, averageViewDuration: 15.3, subscribersGained: 7, subscribersLost: 2 };
      let values;
      if (dimension === 'day') {
        assert.equal(p.get('endDate'), '2026-11-16');
        values = sim.noData ? [] : ['2026-10-13', '2026-10-16', '2026-10-17', '2026-11-13'].map(day => ({ ...sample, day }));
      } else {
        assert.equal(p.get('startDate'), '2026-10-17');
        assert.equal(p.get('endDate'), '2026-11-13');
        values = dimension ? [{ ...sample, country: 'TH', insightTrafficSourceType: 'YT_SEARCH' }] : [{ ...sample, averageViewDuration: 19.42 }];
      }
      return Response.json({ columnHeaders: names.map(name => ({ name })), rows: values.map(row => names.map(n => row[n])) });
    }
  };
  const provider = await createAnalytics({ ...deps, ...options });
  await provider.setClient(client);
  async function begin(target = id) {
    const url = new URL(await provider.begin(target));
    return { url, params: new URLSearchParams({ state: url.searchParams.get('state'), code: 'sensitive-code' }) };
  }
  return { provider, begin, sim, calls, entries, dir,
    time: iso => { time = new Date(iso); }, restart: () => createAnalytics(deps) };
}

test('PKCE binds one consent to the intended channel, returning the report and keeping secrets in Keychain', async t => {
  const env = await fixture(t);
  env.sim.optionalFails = true;
  const { url, params } = await env.begin();
  const q = url.searchParams;
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:47831');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('access_type'), 'offline');
  assert.deepEqual(q.get('scope').split(' ').sort(), [
    'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly',
  ]);
  assert.equal(await env.provider.callback(params, () => [id]), id);
  const verifier = env.calls[0].options.body.get('code_verifier');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), q.get('code_challenge'));
  assert.equal(env.calls[0].options.body.get('redirect_uri'), q.get('redirect_uri'));
  await assert.rejects(env.provider.callback(params, [id]), /already used/);
  const { data, connected, error } = env.provider.state([id]).channels[id];
  assert.equal(connected, true);
  assert.equal(error, null);
  assert.equal(data.from, '2026-10-17');
  assert.equal(data.through, '2026-11-13');
  assert.equal(data.days, 28);
  assert.deepEqual(data.daily.map(row => row.date), ['2026-10-17', '2026-11-13']);
  assert.deepEqual(Object.keys(data.totals), expected);
  assert.equal(data.totals.averageViewDuration, 19.42);
  assert.deepEqual(data.trafficSources, [{ source: 'YT_SEARCH', views: 100, estimatedMinutesWatched: 25.5 }]);
  assert.deepEqual(data.countries, []);
  assert.ok(data.warnings.some(w => w.includes('Country')));
  assert.deepEqual(env.provider.state([other]).channels, { [other]: { connected: false, updatedAt: null, error: null, data: null } });
  const restored = await env.restart();
  assert.deepEqual(restored.state([id]), env.provider.state([id]));
  const files = await readdir(path.join(env.dir, 'analytics'));
  const visible = [url.href, JSON.stringify(env.provider.state([id])), ...await Promise.all(files.map(name => readFile(path.join(env.dir, 'analytics', name), 'utf8')))];
  for (const secret of [...secrets, verifier]) assert.ok(visible.every(value => !value.includes(secret)));
});

test('denies stale, forged, canceled, wrong-channel or no-longer-configured consent safely', async t => {
  const env = await fixture(t);
  const { provider } = env;
  const forged = new URLSearchParams({ state: 'forged', code: 'sensitive-code' });
  await assert.rejects(provider.callback(forged, [id]), /expired/);
  const first = await env.begin();
  const replacement = await env.begin();
  await assert.rejects(provider.callback(first.params, [id]), /expired/);
  await assert.rejects(provider.callback(replacement.params, []), /no longer configured/);
  const canceled = await env.begin();
  canceled.params.set('error', 'access_denied');
  await assert.rejects(provider.callback(canceled.params, [id]), /did not finish/);
  const expired = await env.begin();
  env.time('2026-11-16T08:41:00Z');
  await assert.rejects(provider.callback(expired.params, [id]), /expired/);
  env.sim.identity = other;
  const wrong = await env.begin();
  await assert.rejects(provider.callback(wrong.params, [id]), /different YouTube channel/);
  assert.equal(provider.state([id]).channels[id].connected, false);
  assert.equal(env.entries.size, 1);
  env.sim.identity = id;
  const removed = await env.begin();
  let checks = 0;
  await assert.rejects(provider.callback(removed.params, () => ++checks === 1 ? [id] : []), /no longer configured/);
  assert.equal(env.entries.size, 1);
});

test('refreshes offline, rotates tokens, isolates failures and hides older snapshots', async t => {
  const env = await fixture(t);
  await env.provider.callback((await env.begin()).params, [id]);
  const last = env.provider.state([id]).channels[id];
  const count = env.calls.length;
  await env.provider.tick([id]);
  assert.equal(env.calls.length, count);
  env.time('2026-11-16T14:30:00Z');
  await env.provider.tick([other]);
  assert.equal(env.calls.length, count);
  env.sim.rotate = true;
  env.sim.reportFails = true;
  await env.provider.tick([id]);
  const failed = env.provider.state([id]).channels[id];
  assert.equal(failed.connected, true);
  assert.deepEqual(failed.data, last.data);
  assert.equal(failed.updatedAt, last.updatedAt);
  assert.match(failed.error, /503/);
  assert.ok(!failed.error.includes(secrets[0]));
  assert.equal(env.calls[count].options.body.get('refresh_token'), 'sensitive-refresh');
  const failedCount = env.calls.length;
  env.time('2026-11-16T15:29:00Z');
  await env.provider.tick([id]);
  assert.equal(env.calls.length, failedCount);
  env.time('2026-11-16T15:30:00Z');
  env.sim.reportFails = false;
  await env.provider.tick([id]);
  assert.equal(env.calls[failedCount].options.body.get('refresh_token'), 'sensitive-rotated');
  assert.equal(env.provider.state([id]).channels[id].error, null);
  env.sim.revoked = true;
  await assert.rejects(env.provider.refresh(id), /expired or was revoked/);
  const revoked = env.provider.state([id]).channels[id];
  assert.equal(revoked.connected, false);
  assert.equal(revoked.data, null);
  assert.equal(env.entries.size, 1);
  env.time('2026-12-20T15:32:00Z');
  assert.equal(env.provider.state([id]).channels[id].data, null);
  await env.provider.tick([id]);
  assert.equal(JSON.parse(await readFile(path.join(env.dir, 'analytics', id + '.json'))).data, null);
});

test('consent remains connected when YouTube returns no rows or is temporarily unavailable', async t => {
  const env = await fixture(t);
  env.sim.reportFails = true;
  assert.equal(await env.provider.callback((await env.begin()).params, [id]), id);
  assert.equal(env.provider.state([id]).channels[id].connected, true);
  assert.match(env.provider.state([id]).channels[id].error, /HTTP 503/);
  env.sim.reportFails = false;
  env.sim.noData = true;
  await env.provider.refresh(id);
  const { data, error } = env.provider.state([id]).channels[id];
  assert.equal(error, null);
  assert.equal(data.days, 0);
  assert.equal(data.through, null);
  assert.equal(data.totals.views, null);
  assert.deepEqual(data.daily, []);
});

test('validates the desktop client, channel identifier, and missing connection before contacting Google', async t => {
  const env = await fixture(t);
  await assert.rejects(env.provider.setClient({ clientId: 'wrong', clientSecret: 'secret' }), /Desktop app/);
  await assert.rejects(env.provider.begin('../../path'), /valid YouTube channel/);
  await assert.rejects(env.provider.refresh(id), /Connect this channel/);
  assert.equal(env.calls.length, 0);
});

test('uses the same desktop loopback redirect for consent and token exchange', async t => {
  let port = 49155;
  const env = await fixture(t, { redirectUri: () => 'http://127.0.0.1:' + port });
  const { url, params } = await env.begin();
  port++;
  await env.provider.callback(params, [id]);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:49155');
  assert.equal(env.calls[0].options.body.get('redirect_uri'), url.searchParams.get('redirect_uri'));
});
