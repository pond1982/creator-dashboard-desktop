import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getChannels } from './youtube.mjs';
import { dailyPaidDownloads, getSales, latestAppleReportDate, validateApplePeriod } from './apple.mjs';
import { keychain } from './keychain.mjs';
import { support } from './paths.mjs';

const sources = ['youtube', 'apple'];
const minute = 60000;

function credentials(source, input) {
  const string = (key, max = 256) => {
    const val = input[key];
    if (typeof val !== 'string' || !val.trim() || val.length > max) {
      throw new Error(`Please check the ${key} field.`);
    }
    return val.trim();
  };
  if (source === 'youtube') {
    if (!Array.isArray(input.inputs) || !input.inputs.length ||
        input.inputs.some(value => typeof value !== 'string' || !value.trim() || value.length > 500)) {
      throw new Error('Enter at least one YouTube channel. Use one handle, channel ID, or channel URL per entry.');
    }
    return { apiKey: string('apiKey'), inputs: input.inputs.map(value => value.trim()) };
  }
  return { keyId: string('keyId'), issuerId: string('issuerId'), vendorNumber: string('vendorNumber'), privateKey: string('privateKey', 8000) };
}

export async function createDashboard({ dir = support, vault = keychain, youtube = getChannels, apple = getSales, now = () => new Date() } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const records = {};
  const busy = { youtube: false, apple: false };
  const file = source => path.join(dir, source + '.json');
  for (const source of sources) {
    try {
      records[source] = JSON.parse(await readFile(file(source), 'utf8'));
      if (!records[source]?.account) throw new Error('Invalid saved source');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read the saved ${source} dashboard file in the dashboard’s data folder.`);
      records[source] = { data: null, updatedAt: null, error: null };
    }
  }

  async function save(source, record) {
    const tmp = file(source) + '.tmp';
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await rename(tmp, file(source));
    records[source] = record;
  }

  function state({ includeDailySales = false } = {}) {
    const result = { busy: { ...busy } };
    for (const source of sources) {
      const { account, data, updatedAt, error, meta } = records[source];
      result[source] = { configured: Boolean(account), data, updatedAt, error, ...meta };
    }
    if (includeDailySales) {
      const record = records.apple;
      result.apple.dailyPaidDownloads = record.dailyPaidDownloads ?? dailyPaidDownloads(record.data, record.cache);
    }
    return result;
  }

  // Setup, scheduled refreshes and period requests all read and replace the same Apple record.
  let appleQueue = Promise.resolve();
  let appleTasks = 0;
  function withApple(task) {
    appleTasks++;
    busy.apple = true;
    const finished = appleQueue.then(task).finally(() => {
      busy.apple = --appleTasks > 0;
    });
    appleQueue = finished.catch(() => {});
    return finished;
  }

  async function savedCredentials(record) {
    const saved = await vault('get', record.account);
    try {
      return JSON.parse(saved);
    } catch {
      throw new Error('The saved connection is unreadable. Reconnect this source in the dashboard.');
    }
  }

  async function applePeriod(days) {
    validateApplePeriod(days);
    return withApple(async () => {
      const previous = records.apple;
      if (!previous.account) throw new Error('Connect App Store Connect first.');
      const config = await savedCredentials(previous);
      const { cache, ...report } = await apple(config, previous.cache, { now: now(), days });
      // This request changes the reusable cache but preserves the default
      // report. Keep its chart on the same revision as its headline totals.
      await save('apple', { ...previous, cache,
        dailyPaidDownloads: previous.dailyPaidDownloads ?? dailyPaidDownloads(previous.data, previous.cache) });
      return report;
    });
  }

  async function sync(source, setup) {
    if (!sources.includes(source)) throw new Error('Choose YouTube or App Store Connect.');
    if (source === 'apple') return withApple(() => syncRecord(source, setup));
    if (busy[source]) throw new Error('A refresh is already running for this source.');
    busy[source] = true;
    try {
      await syncRecord(source, setup);
    } finally {
      busy[source] = false;
    }
  }

  async function syncRecord(source, setup) {
    const previous = records[source];
    if (!setup && !previous.account) throw new Error('Connect this source first.');
    const attempt = now().toISOString();
    try {
      let saved;
      if (setup && source === 'youtube' && previous.account &&
          (setup.apiKey === undefined || (typeof setup.apiKey === 'string' && !setup.apiKey.trim()))) {
        saved = await savedCredentials(previous);
        setup = { ...setup, apiKey: saved.apiKey };
      }
      const config = setup ? credentials(source, setup) : await savedCredentials(previous);
      let data, cache, meta;
      if (source === 'youtube') {
        const inputs = setup ? config.inputs : previous.meta?.inputs ?? config.inputs;
        const knownIds = previous.channelIds ?? previous.data?.map(channel => channel.id) ?? config.channelIds ?? saved?.channelIds ?? [];
        const knownInputs = previous.meta?.inputs ?? config.inputs ?? [];
        const identities = new Map(knownInputs.map((input, index) => [input, knownIds[index]]));
        data = await youtube(inputs.map(input => identities.get(input) || input), config.apiKey);
        meta = { inputs };
      } else {
        const { keyId, issuerId, vendorNumber } = config;
        meta = { keyId, issuerId, vendorNumber };
        // A new submission must authenticate against Apple even if every day was cached.
        const report = await apple(config, setup ? null : previous.cache, { now: now() });
        ({ cache, ...data } = report);
      }
      const record = { data, cache, meta, updatedAt: now().toISOString(), lastAttemptAt: attempt, error: null, account: previous.account };
      if (source === 'youtube') record.channelIds = data.map(channel => channel.id);
      else record.dailyPaidDownloads = dailyPaidDownloads(data, cache);
      if (setup) {
        record.account = `${source}-${randomUUID()}`;
        // Channel labels and immutable IDs live in the source record. This keeps the
        // Keychain payload small even for a long list of short handles.
        const secret = source === 'youtube' ? { apiKey: config.apiKey } : config;
        await vault('set', record.account, JSON.stringify(secret));
      }
      try {
        await save(source, record);
      } catch {
        if (setup) await vault('delete', record.account).catch(() => {});
        throw new Error('Could not save the dashboard. Check free space and permissions in the dashboard’s data folder.');
      }
      if (setup && previous.account) await vault('delete', previous.account).catch(() => {});
    } catch (error) {
      if (!setup) {
        await save(source, { ...previous, lastAttemptAt: attempt, error: error.message });
      }
      throw error;
    }
  }

  async function tick(enabledSources = sources) {
    const time = now();
    await Promise.all(sources.map(async source => {
      let record = records[source];
      if (!record.account || busy[source]) return;
      // Discard expired YouTube API metadata if the dashboard could not refresh it for 30 days.
      if (source === 'youtube' && record.data && time - Date.parse(record.updatedAt) >= 30 * 24 * 60 * minute) {
        busy[source] = true;
        try {
          const channelIds = record.channelIds ?? record.data.map(channel => channel.id);
          await save(source, { ...record, channelIds, data: null, error: 'The cached YouTube statistics expired. A fresh sync is needed.' });
          record = records[source];
        } finally {
          busy[source] = false;
        }
      }
      if (!enabledSources.includes(source)) return;
      const elapsed = time - Date.parse(record.lastAttemptAt || 0);
      const age = time - Date.parse(record.updatedAt || 0);
      if (record.error && elapsed < (source === 'apple' ? 60 : 30) * minute) return;
      const due = source === 'youtube' ? age >= 30 * minute :
        !record.updatedAt || latestAppleReportDate(time) !== latestAppleReportDate(new Date(record.updatedAt)) ||
        (record.data?.complete === false && age >= 180 * minute);
      if (due || record.error) await sync(source).catch(() => {}); // Persisted per-source error is shown in the UI.
    }));
  }
  return { state, sync, tick, applePeriod };
}
