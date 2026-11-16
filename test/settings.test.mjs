import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSettings } from '../settings.mjs';

async function fixture(t, configured = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'creator-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { youtube: { configured }, apple: { configured: false } };
  return { dir, state, store: await openSettings(dir, state) };
}

test('new installations start in onboarding and connected installations retain their dashboard', async t => {
  const fresh = await fixture(t);
  const legacy = await fixture(t, true);
  assert.deepEqual(fresh.store.get(), { onboarded:false, sources:['youtube','apple'], theme:'midnight', visibleChannelIds:null });
  assert.equal(legacy.store.get().onboarded,true);
});

test('settings survive restart and preserve explicit empty channel selections', async t => {
  const { store, dir, state } = await fixture(t);
  const options = { onboarded:true, sources:['apple'], theme:'daylight', visibleChannelIds:[] };
  await store.save(options);
  assert.deepEqual((await openSettings(dir,state)).get(),options);
  for (const invalid of [{sources:[]},{sources:['unknown']},{theme:'other'},{visibleChannelIds:['private input']}]) {
    await assert.rejects(store.save({ ...options, ...invalid }));
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'settings.json'),'utf8')),options);
  const first = { ...options, sources:['youtube'], theme:'aurora', visibleChannelIds:['UC' + 'x'.repeat(22)] };
  const last = { ...options, sources:['youtube','apple'], visibleChannelIds:null };
  await Promise.all([store.save(first), store.save(last)]);
  assert.deepEqual((await openSettings(dir,state)).get(),last);
});
