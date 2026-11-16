import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createVault, offerMacImport } from '../desktop/storage.mjs';

const id = 'UC' + 'A'.repeat(22);
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(text).reverse(),
  decryptString: bytes => Buffer.from(bytes).reverse().toString(),
};

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'argus-import-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'dashboard'), legacyDir = path.join(root, 'legacy');
  await mkdir(path.join(legacyDir, 'analytics'), { recursive: true });
  const records = {
    'youtube.json': { account: 'youtube-example', data: [{ id, title: 'Test channel' }] },
    'apple.json': { account: 'apple-example', data: { apps: [{ id: 'test' }] } },
    'settings.json': { theme: 'midnight' },
    'analytics/client.json': { configured: true },
    ['analytics/' + id + '.json']: { connected: true, data: { totals: { views: 75 } } },
  };
  for (const [file, value] of Object.entries(records)) await writeFile(path.join(legacyDir, file), JSON.stringify(value));
  const accounts = new Map([
    ['youtube-example', 'fixture-public-key'], ['apple-example', 'fixture-team-key'],
    ['analytics-desktop-client', 'fixture-client'], ['analytics-grant-' + id, 'fixture-grant'],
  ]);
  const options = {
    dir, legacyDir, encryption: cipher, isRunning: async () => false,
    legacyGet: async ref => { assert.ok(accounts.has(ref)); return accounts.get(ref); },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
  };
  return { root, dir, legacyDir, options, records, accounts };
}

test('imports all sources and private grants after the previous service stops, preserving originals', async t => {
  const { dir, legacyDir, options, records, accounts } = await setup(t);
  const prompts = [];
  let checks = 0;
  options.isRunning = async () => ++checks === 1;
  options.dialog.showMessageBox = async modal => {
    prompts.push(modal.buttons[0]);
    return { response: 0 };
  };
  assert.equal(await offerMacImport(options), true);
  assert.deepEqual(prompts, ['Check again', 'Import setup']);
  for (const [filename, original] of Object.entries(records)) {
    for (const folder of [legacyDir, dir]) {
      assert.deepEqual(JSON.parse(await readFile(path.join(folder, filename), 'utf8')), original);
    }
  }
  const vault = await createVault(dir, cipher);
  for (const [account, secret] of accounts) assert.equal(await vault('get', account), secret);
  await vault('set', 'apple-example', 'changed-in-desktop');
  assert.equal(accounts.get('apple-example'), 'fixture-team-key');
  // Reopening an already connected desktop setup must not overwrite it.
  const unexpected = () => assert.fail('import attempted for an already configured installation');
  await offerMacImport({ ...options, legacyGet: unexpected, dialog: { showMessageBox: unexpected } });
  assert.equal(await vault('get', 'apple-example'), 'changed-in-desktop');
});

test('failed import leaves the previous settings, source credentials and reports intact for a retry', async t => {
  const { root, dir, legacyDir, options, records, accounts } = await setup(t);
  await mkdir(dir);
  const preferences = JSON.stringify({ theme: 'aurora' });
  await writeFile(path.join(dir, 'settings.json'), preferences);
  const expectedAccounts = [...accounts];
  const denied = async ref => {
    if (ref === 'analytics-grant-' + id) throw new Error('Synthetic Keychain rejection');
    return options.legacyGet(ref);
  };
  await assert.rejects(offerMacImport({ ...options, legacyGet: denied }), /could not be imported/);
  assert.deepEqual(await readdir(dir), ['settings.json']);
  assert.equal(await readFile(path.join(dir, 'settings.json'), 'utf8'), preferences);
  assert.deepEqual([...accounts], expectedAccounts);
  assert.deepEqual((await readdir(root)).sort(), ['dashboard', 'legacy']);
  for (const [file, value] of Object.entries(records)) {
    assert.deepEqual(JSON.parse(await readFile(path.join(legacyDir, file), 'utf8')), value);
  }

  await offerMacImport(options);
  assert.equal(await readFile(path.join(dir, 'settings.json'), 'utf8'), preferences);
  const backup = (await readdir(root)).find(name => name.startsWith('dashboard.before-import-'));
  assert.ok(backup);
  assert.equal(await readFile(path.join(root, backup, 'settings.json'), 'utf8'), preferences);
});

test('a destination with existing protected credentials is never replaced', async t => {
  const { dir, options } = await setup(t);
  const vault = await createVault(dir, cipher);
  await vault('set', 'my-existing-account', 'my-existing-test-value');
  const unexpected = () => assert.fail('existing vault should not trigger an import');
  await offerMacImport({ ...options, legacyGet: unexpected, dialog: { showMessageBox: unexpected } });
  assert.equal(await vault('get', 'my-existing-account'), 'my-existing-test-value');
});
