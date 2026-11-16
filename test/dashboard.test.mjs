import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDashboard } from "../dashboard.mjs";

const youTubeConfig = { inputs: ["@first", "@second", "@third"], apiKey: "secret-for-test-youtube" };
const appleConfig = {
  keyId: "PUBLIC-KEY-ID", issuerId: "PUBLIC-ISSUER-ID", vendorNumber: "123456",
  privateKey: "secret-for-test-apple",
};

async function fixture(t, start = "2026-03-07T16:00:00Z") {
  const dir = await mkdtemp(path.join(tmpdir(), "creator-dashboard-test-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const entries = new Map();
  const calls = { youtube: [], apple: [] };
  const options = { youtubeError: null, appleError: null, complete: true };
  let time = new Date(start);
  const deps = {
    dir,
    now: () => new Date(time),
    vault: async (op, id, value) => {
      if (op === "set") entries.set(id, value);
      else if (op === "delete") entries.delete(id);
      else if (op === "get" && entries.has(id)) return entries.get(id);
      else throw new Error("Missing test vault entry");
    },
    youtube: async (inputs, key) => {
      calls.youtube.push({ inputs, key });
      if (options.youtubeError) throw new Error(options.youtubeError);
      return inputs.map(input => ({ id: options.resolveId?.(input) ?? input, title: input, video: null, subscribers: calls.youtube.length }));
    },
    apple: async (config, cache, { now, days }) => {
      calls.apple.push({ config, cache, now, days });
      if (options.appleWait) await options.appleWait;
      if (options.appleError) throw new Error(options.appleError);
      return { apps: [], complete: options.complete, ...(days ? { days } : {}), cache: { fixtureRevision: calls.apple.length } };
    },
  };
  return {
    dir, entries, options, calls,
    dashboard: await createDashboard(deps),
    restart: () => createDashboard(deps),
    setTime: (when) => { time = new Date(when); },
  };
}

test("configuration and refresh store secrets only in the vault and survive a restart", async t => {
  const { dashboard, restart, calls, entries, dir } = await fixture(t);
  assert.equal(dashboard.state().youtube.configured, false);
  await dashboard.sync("youtube", youTubeConfig);
  await dashboard.sync("apple", appleConfig);
  assert.equal(calls.apple[0].cache, null);
  const restored = await restart();
  assert.deepEqual(restored.state(), dashboard.state());
  await Promise.all([restored.sync("youtube"), restored.sync("apple")]);
  assert.deepEqual(calls.youtube[1], { inputs: youTubeConfig.inputs, key: youTubeConfig.apiKey });
  assert.deepEqual(calls.apple[1].config, appleConfig);
  assert.deepEqual(calls.apple[1].cache, { fixtureRevision: 1 });
  const state = restored.state();
  assert.equal(state.youtube.configured, true);
  assert.equal(state.apple.configured, true);
  assert.deepEqual(state.apple.data, { apps: [], complete: true });
  assert.equal(state.youtube.data[0].subscribers, 2);
  assert.equal(entries.size, 2);
  for (const serialized of [
    JSON.stringify(state),
    await readFile(path.join(dir, "youtube.json"), "utf8"),
    await readFile(path.join(dir, "apple.json"), "utf8"),
  ]) {
    assert.ok(!serialized.includes(youTubeConfig.apiKey));
    assert.ok(!serialized.includes(appleConfig.privateKey));
  }
});

test("a rejected replacement keeps the connected account, data and credentials", async t => {
  const { dashboard, options, calls, entries, restart } = await fixture(t);
  await dashboard.sync("apple", appleConfig);
  const before = dashboard.state();
  const oldEntries = Array.from(entries);
  const replacement = { ...appleConfig, privateKey: "replacement-secret" };
  options.appleError = "Apple rejected the key.";
  await assert.rejects(dashboard.sync("apple", replacement), /Apple rejected/);
  assert.equal(calls.apple[1].cache, null, "new credentials must be verified with the provider");
  assert.deepEqual(dashboard.state(), before);
  assert.deepEqual(Array.from(entries), oldEntries);
  const restored = await restart();
  options.appleError = null;
  await restored.sync("apple");
  assert.deepEqual(calls.apple[2].config, appleConfig);
  assert.deepEqual(calls.apple[2].cache, { fixtureRevision: 1 });
  await restored.sync("apple", replacement);
  assert.equal(entries.size, 1);
  assert.ok(!entries.has(oldEntries[0][0]));
  assert.deepEqual(JSON.parse([...entries.values()][0]), replacement);
});

test("edits channel membership and order with the saved key and keeps the previous list on failure", async t => {
  const { dashboard, entries, calls, options, restart } = await fixture(t);
  const ids = ["A", "B", "C", "D", "E"].map(s => "UC" + s.repeat(22));
  const handles = ["@one", "@two", "@three", "@four", "@five"];
  const mapping = new Map(handles.map((handle, n) => [handle, ids[n]]));
  options.resolveId = input => mapping.get(input) ?? input;
  await assert.rejects(dashboard.sync("youtube", { inputs: handles, apiKey: "" }), /apiKey/);
  await assert.rejects(dashboard.sync("youtube", { inputs: [], apiKey: youTubeConfig.apiKey }), /at least one/);
  await dashboard.sync("youtube", { inputs: handles.slice(0, 3), apiKey: youTubeConfig.apiKey });
  const original = dashboard.state();
  const accounts = [...entries];
  const newInputs = ["@three", "@four", "@one", "@five"];
  options.youtubeError = "Channel not found.";
  await assert.rejects(dashboard.sync("youtube", { inputs: newInputs }), /Channel not found/);
  assert.deepEqual(dashboard.state(), original);
  assert.deepEqual([...entries], accounts);
  options.youtubeError = null;
  mapping.set("@three", ids[1]); // The saved handle was reassigned, its original channel ID is still pinned.
  await dashboard.sync("youtube", { inputs: newInputs, apiKey: " " });
  assert.deepEqual(calls.youtube.at(-1), { inputs: [ids[2], "@four", ids[0], "@five"], key: youTubeConfig.apiKey });
  const orderedIds = [ids[2], ids[3], ids[0], ids[4]];
  assert.deepEqual(dashboard.state().youtube.data.map(row => row.id), orderedIds);
  assert.deepEqual(dashboard.state().youtube.inputs, newInputs);
  assert.deepEqual(JSON.parse([...entries.values()][0]), { apiKey: youTubeConfig.apiKey });
  const reopened = await restart();
  await reopened.sync("youtube");
  assert.deepEqual(calls.youtube.at(-1), { inputs: orderedIds, key: youTubeConfig.apiKey });
  await reopened.sync("youtube", { inputs: ["@four"], apiKey: "new-key" });
  assert.deepEqual(calls.youtube.at(-1), { inputs: [ids[3]], key: "new-key" });
  assert.deepEqual(reopened.state().youtube.inputs, ["@four"]);
  assert.equal(entries.size, 1);
});

test("reads the legacy three-channel connection when its public snapshot expired", async t => {
  const { dir, restart, entries, calls } = await fixture(t);
  const channelIds = ["A", "B", "C"].map(s => "UC" + s.repeat(22));
  entries.set("legacy", JSON.stringify({ ...youTubeConfig, channelIds }));
  await writeFile(path.join(dir, "youtube.json"), JSON.stringify({
    account: "legacy", data: null, updatedAt: null, error: null, meta: { inputs: youTubeConfig.inputs },
  }));
  let restored = await restart();
  await restored.sync("youtube", { inputs: youTubeConfig.inputs, apiKey: "" });
  assert.deepEqual(calls.youtube[0], { inputs: channelIds, key: youTubeConfig.apiKey });
  assert.deepEqual(restored.state().youtube.inputs, youTubeConfig.inputs);
  restored = await restart();
  await restored.sync("youtube");
  assert.deepEqual(calls.youtube[1], { inputs: channelIds, key: youTubeConfig.apiKey });
});

test("disabled sources skip background fetches and still expire cached YouTube data", async t => {
  const { dashboard, calls, setTime } = await fixture(t);
  await dashboard.sync("youtube", youTubeConfig);
  await dashboard.sync("apple", appleConfig);
  setTime("2026-03-08T16:30:00Z");
  await dashboard.tick(["youtube"]);
  assert.equal(calls.youtube.length, 2);
  assert.equal(calls.apple.length, 1);
  setTime("2026-04-15T16:30:00Z");
  await dashboard.tick([]);
  assert.equal(dashboard.state().youtube.data, null);
  assert.equal(calls.youtube.length, 2);
  assert.equal(calls.apple.length, 1);
  await dashboard.tick(["apple"]);
  assert.equal(calls.youtube.length, 2);
  assert.equal(calls.apple.length, 2);
  await dashboard.tick();
  assert.equal(calls.youtube.length, 3);
  assert.ok(dashboard.state().youtube.data);
});

test("retains data and retries a failed source independently of a successful source", async t => {
  const { dashboard, calls, options, setTime, restart } = await fixture(t);
  await dashboard.sync("apple", appleConfig);
  await dashboard.sync("youtube", youTubeConfig);
  const lastGood = dashboard.state().youtube;
  options.youtubeError = "Could not reach YouTube.";
  setTime("2026-03-08T15:00:00Z");
  await dashboard.tick();
  const state = dashboard.state();
  assert.deepEqual(state.youtube.data, lastGood.data);
  assert.equal(state.youtube.updatedAt, lastGood.updatedAt);
  assert.match(state.youtube.error, /Could not reach YouTube/);
  assert.equal(state.apple.updatedAt, "2026-03-08T15:00:00.000Z");
  assert.equal(state.apple.error, null);
  const restored = await restart();
  assert.deepEqual(restored.state(), state);
  setTime("2026-03-08T15:29:59Z");
  await restored.tick();
  assert.equal(calls.youtube.length, 2);
  options.youtubeError = null;
  setTime("2026-03-08T15:30:00Z");
  await restored.tick();
  assert.equal(calls.youtube.length, 3);
  assert.equal(restored.state().youtube.error, null);
  assert.equal(restored.state().youtube.data[0].subscribers, 3);
  assert.equal(calls.apple.length, 2);
});

test("refreshes complete Apple reports at 8 a.m. Pacific across both DST changes", async t => {
  const transitions = [
    ["2026-03-07T16:00:00Z", "2026-03-08T14:59:59Z", "2026-03-08T15:00:00Z"],
    ["2026-10-31T15:00:00Z", "2026-11-01T15:59:59Z", "2026-11-01T16:00:00Z"],
  ];
  for (const [start, before, at] of transitions) {
    const { dashboard, calls, setTime } = await fixture(t, start);
    await dashboard.sync("apple", appleConfig);
    setTime(before);
    await dashboard.tick();
    assert.equal(calls.apple.length, 1);
    setTime(at);
    await dashboard.tick();
    await dashboard.tick();
    assert.equal(calls.apple.length, 2);
  }
});

test("rechecks missing reports after three hours and retries Apple errors after one hour", async t => {
  const { dashboard, calls, options, setTime } = await fixture(t);
  options.complete = false;
  await dashboard.sync("apple", appleConfig);
  setTime("2026-03-07T18:59:59Z");
  await dashboard.tick();
  assert.equal(calls.apple.length, 1);
  options.appleError = "Apple is temporarily unavailable.";
  setTime("2026-03-07T19:00:00Z");
  await dashboard.tick();
  assert.equal(calls.apple.length, 2);
  assert.match(dashboard.state().apple.error, /temporarily unavailable/);
  setTime("2026-03-07T19:59:59Z");
  await dashboard.tick();
  assert.equal(calls.apple.length, 2);
  options.appleError = null;
  options.complete = true;
  setTime("2026-03-07T20:00:00Z");
  await dashboard.tick();
  assert.equal(calls.apple.length, 3);
  assert.equal(dashboard.state().apple.error, null);
  assert.equal(dashboard.state().apple.data.complete, true);
  assert.deepEqual(calls.apple[2].cache, { fixtureRevision: 1 });
});

test("historical periods share the cache after restart and preserve the default report on success or failure", async t => {
  const { dashboard, entries, restart, calls, options } = await fixture(t);
  await assert.rejects(dashboard.applePeriod(90), /Connect App Store Connect/);
  await dashboard.sync("apple", appleConfig);
  const snapshot = dashboard.state().apple;
  assert.deepEqual(await dashboard.applePeriod(90), { days: 90, apps: [], complete: true });
  assert.deepEqual(calls.apple[1].cache, { fixtureRevision: 1 });
  assert.equal(calls.apple[1].days, 90);
  assert.deepEqual(dashboard.state().apple, snapshot);
  assert.equal(entries.size, 1);

  const restored = await restart();
  options.appleError = "Temporary historical report error";
  await assert.rejects(restored.applePeriod(30), /Temporary historical/);
  assert.deepEqual(restored.state().apple, snapshot);
  options.appleError = null;
  await restored.sync("apple");
  assert.deepEqual(calls.apple.at(-1).cache, { fixtureRevision: 2 });
  await assert.rejects(restored.applePeriod(2), /period/);
});

test("serializes period reads with refreshes and replacement credentials", async t => {
  const { dashboard, calls, options } = await fixture(t);
  await dashboard.sync("apple", appleConfig);

  let release;
  options.appleWait = new Promise(resolve => { release = resolve; });
  const period = dashboard.applePeriod(90);
  const refresh = dashboard.sync("apple");
  const setup = dashboard.sync("apple", { ...appleConfig, vendorNumber: "NEW" });
  const afterReplacement = dashboard.applePeriod(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dashboard.state().busy.apple, true);
  assert.equal(calls.apple.length, 2);
  assert.equal(calls.apple[1].days, 90);
  release();
  await Promise.all([period, refresh, setup, afterReplacement]);
  assert.equal(dashboard.state().busy.apple, false);
  assert.deepEqual(calls.apple[2].cache, { fixtureRevision: 2 });
  assert.equal(calls.apple[3].cache, null);
  assert.equal(calls.apple[4].config.vendorNumber, "NEW");
  assert.deepEqual(calls.apple[4].cache, { fixtureRevision: 4 });
});
