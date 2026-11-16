import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sources = ['youtube', 'apple'];
const themes = ['midnight', 'aurora', 'daylight'];

function validate(input) {
  if (!input || typeof input.onboarded !== 'boolean') throw new Error('Choose your dashboard settings first.');
  if (!Array.isArray(input.sources) || !input.sources.length ||
      !input.sources.every(source => sources.includes(source))) {
    throw new Error('Select YouTube, App Store Connect, or both.');
  }
  if (!themes.includes(input.theme)) throw new Error('Select an available theme.');
  const ids = input.visibleChannelIds;
  if (ids !== null && (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(id)))) {
    throw new Error('Select channels from the connected channel list.');
  }
  return {
    onboarded: input.onboarded,
    sources: sources.filter(source => input.sources.includes(source)),
    theme: input.theme,
    visibleChannelIds: ids === null ? null : [...new Set(ids)]
  };
}

export async function openSettings(dir, currentState) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'settings.json');
  let settings;
  try {
    settings = validate(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read settings.json in Creator Dashboard’s data folder.');
    settings = {
      onboarded: sources.some(source => currentState[source]?.configured),
      sources: [...sources],
      theme: 'midnight',
      visibleChannelIds: null
    };
  }

  let lastSave = Promise.resolve();
  return {
    get: () => settings,
    async save(input) {
      const next = validate(input);
      // Serialize writes from different browser tabs and publish only after the rename succeeds.
      const pending = lastSave.then(async () => {
        await writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
        await rename(file + '.tmp', file);
        settings = next;
        return next;
      });
      lastSave = pending.catch(() => {});
      return pending;
    }
  };
}
