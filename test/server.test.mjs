import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { get } from 'node:http';
import path from 'node:path';
import { createDashboard } from '../dashboard.mjs';
import { makeServer } from '../server.mjs';
import { openSettings } from '../settings.mjs';

test('desktop sessions protect loopback data and persist onboarding and channel changes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'creator-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = new Map();
  const vault = async (op, account, value) => {
    if (op === 'set') entries.set(account, value);
    else if (op === 'delete') entries.delete(account);
    else return entries.get(account);
  };
  const channels = ['a','b','c','d'].map(c => 'UC' + c.repeat(22));
  const dashboard = await createDashboard({ dir, vault, youtube: async (ids, key) => {
    assert.equal(key, 'example-only');
    return ids.map(id => ({ id, title: 'Sample', videos: [] }));
  } });
  const settings = await openSettings(dir, dashboard.state());
  const analytics = { state: () => ({}), callback: async query => {
    if (query.get('state') !== 'expected') throw new Error('Expired sign-in.');
    return channels[0];
  } };
  let origin;
  const sessionToken = 'test-session';
  const server = await makeServer(dashboard, 0, analytics, settings, { sessionToken, getOrigin: () => origin });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  origin = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'X-Creator-Session': sessionToken, 'X-Dashboard-Request':'1', 'Content-Type':'application/json' };
  const post = (route, body) => fetch(origin + route, { method:'POST', headers, body:JSON.stringify(body) });
  for (const route of ['/', '/app.js', '/pondd.glb', '/pondd-texture-0.jpg', '/api/state', '/oauth/google/callback']) {
    assert.equal((await fetch(origin + route)).status, 403);
  }
  assert.equal((await fetch(origin + '/api/state', { headers:{ 'X-Creator-Session':'incorrect' } })).status, 403);
  for (const [asset, type] of [['/pondd.glb','model/gltf-binary'], ['/pondd-texture-0.jpg','image/jpeg'], ['/pondd-three.js','text/javascript']]) {
    const response = await fetch(origin + asset, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), type);
    assert(response.headers.get('content-security-policy').includes("script-src 'self'"));
    assert(response.headers.get('content-security-policy').includes("connect-src 'self'"));
  }
  const wrongHost = await new Promise((resolve, reject) => {
    get(origin + '/api/state', { headers: { ...headers, host: 'example.com' } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(origin + '/api/settings', { method:'POST', headers:{ ...headers, origin:'https://example.com' }, body:'{}' })).status, 403);
  assert.equal((await fetch(origin + '/?code=demo&state=wrong')).status, 400);
  assert.match(await (await fetch(origin + '/?code=demo&state=expected')).text(), /return to Argus Pip/);
  assert.equal((await post('/api/setup/youtube', { apiKey:'example-only', inputs:channels.slice(0,1) })).status, 200);
  assert.equal((await post('/api/setup/youtube', { apiKey:'', inputs:channels })).status, 200);
  const preferences = { onboarded:true, theme:'aurora', sources:['youtube'], visibleChannelIds:channels.slice(1,3) };
  assert.equal((await post('/api/settings', preferences)).status, 200);
  const snapshot = await (await fetch(origin + '/api/state', { headers })).json();
  assert.deepEqual(snapshot.youtube.data.map(c => c.id), channels);
  assert.deepEqual(snapshot.settings, preferences);
  assert.deepEqual((await openSettings(dir, dashboard.state())).get(), preferences);
});
