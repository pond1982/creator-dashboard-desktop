import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);

export async function createVault(dir, encryption) {
  const folder = path.join(dir, 'credentials');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  // Serialize rotations and mutations to a particular Keychain/DPAPI item.
  const writes = new Map();
  return function vault(op, account, value) {
    const previous = writes.get(account) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (typeof account !== 'string' || !account) throw new Error('Invalid credential reference.');
      const file = path.join(folder, createHash('sha256').update(account).digest('hex') + '.bin');
      if (op === 'delete') return rm(file, { force: true });
      const asyncApi = typeof encryption.encryptStringAsync === 'function';
      const available = asyncApi ? await encryption.isAsyncEncryptionAvailable() : encryption.isEncryptionAvailable();
      if (!available) throw new Error('Unlock your OS credential store and try again.');
      async function store(secret) {
        const bytes = asyncApi ? await encryption.encryptStringAsync(secret) : encryption.encryptString(secret);
        const temp = file + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
          await rename(temp, file);
        } finally { await rm(temp, { force: true }).catch(() => {}); }
      }
      if (op === 'set' && typeof value === 'string') return store(value);
      if (op !== 'get') throw new Error('Invalid credential operation.');
      const bytes = await readFile(file);
      if (!asyncApi) return encryption.decryptString(bytes);
      const { result, shouldReEncrypt } = await encryption.decryptStringAsync(bytes);
      if (typeof result !== 'string') throw new Error('Credential unavailable.');
      if (shouldReEncrypt) await store(result);
      return result;
    }).catch(error => {
      if (error.code === 'ENOENT') throw new Error('The saved credential is missing. Reconnect this source in the dashboard.');
      throw new Error('Could not access the OS-protected credential. Unlock your account and try again.');
    });
    writes.set(account, operation);
    return operation.finally(() => { if (writes.get(account) === operation) writes.delete(account); });
  };
}

const exists = async file => Boolean(await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; }));
async function legacyRunning() {
  try { await execute('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/local.creator-dashboard']); return true; }
  catch {
    try {
      const response = await fetch('http://127.0.0.1:47831/api/health', { redirect: 'error', signal: AbortSignal.timeout(700) });
      return (await response.json()).service === 'creator-dashboard';
    } catch { return false; }
  }
}

// Import into a fresh sibling, then publish the complete import with one rename.
// Read legacy Keychain items only after consent; never set or delete them.
export async function offerMacImport({ dir, legacyDir, legacyGet, encryption, dialog }) {
  if (await exists(dir)) return true;
  const candidates = [];
  for (const file of ['youtube.json', 'apple.json', 'settings.json']) {
    if (await exists(path.join(legacyDir, file))) candidates.push(file);
  }
  if (!candidates.some(file => file !== 'settings.json')) return true;
  if (await legacyRunning()) {
    const { response } = await dialog.showMessageBox({
      type: 'info', title: 'Previous dashboard is running', message: 'Your previous Mac dashboard is still running.',
      detail: 'To import its connections, quit this app, run npm stop in the previous project, then reopen Creator Dashboard. Starting fresh gives this desktop app a separate setup.',
      buttons: ['Quit to import later', 'Start fresh'], defaultId: 0, cancelId: 0,
    });
    return response === 1;
  }
  const { response } = await dialog.showMessageBox({
    type: 'question', title: 'Import previous Mac setup', message: 'Import the connections and reports from your previous Mac dashboard?',
    detail: 'This makes a separate copy of your saved reports, settings and credentials. Keep the previous background service stopped while this app refreshes the same Google grants.',
    buttons: ['Import setup', 'Start fresh', 'Quit'], defaultId: 0, cancelId: 2,
  });
  if (response !== 0) return response === 1;
  const stage = await mkdtemp(path.join(path.dirname(dir), '.import-'));
  try {
    const vault = await createVault(stage, encryption);
    const accounts = new Set();
    async function copyRecord(file) {
      const raw = await readFile(path.join(legacyDir, file), 'utf8');
      const record = JSON.parse(raw);
      await writeFile(path.join(stage, file), raw, { mode: 0o600 });
      return record;
    }
    for (const file of candidates) {
      const record = await copyRecord(file);
      if (file !== 'settings.json') {
        if (typeof record.account !== 'string' || !record.account) throw new Error('Invalid source.');
        accounts.add(record.account);
      }
    }
    const analytics = path.join(legacyDir, 'analytics');
    if (await exists(analytics)) {
      await mkdir(path.join(stage, 'analytics'), { mode: 0o700 });
      for (const file of await readdir(analytics)) {
        if (file !== 'client.json' && !/^UC[A-Za-z0-9_-]{22}\.json$/.test(file)) continue;
        const record = await copyRecord(path.join('analytics', file));
        if (file === 'client.json') accounts.add('analytics-desktop-client');
        else if (record.connected) accounts.add('analytics-grant-' + file.slice(0, -5));
      }
    }
    for (const account of accounts) await vault('set', account, await legacyGet(account));
    if (await legacyRunning() || await exists(dir)) throw new Error('Setup changed during import.');
    await rename(stage, dir);
    return true;
  } catch {
    throw new Error('The previous setup could not be imported. Unlock the login Keychain, check that the previous service is stopped and reopen this app to try again. Your original data is still available.');
  } finally { await rm(stage, { recursive: true, force: true }); }
}
