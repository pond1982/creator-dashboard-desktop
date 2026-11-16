import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage, session, shell, Tray } from 'electron';
import { randomBytes, webcrypto } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDashboard } from '../dashboard.mjs';
import { createAnalytics } from '../analytics.mjs';
import { keychain } from '../keychain.mjs';
import { support as legacyDir } from '../paths.mjs';
import { reportDocument } from '../reports.mjs';
import { makeServer } from '../server.mjs';
import { openSettings } from '../settings.mjs';
import { createVault, offerMacImport } from './storage.mjs';
import { widgetPublisher, widgetSnapshot } from './widget-snapshot.mjs';
import { widgetRoute } from './widget-link.mjs';

const brand = 'Argus Pip';
const smoke = process.argv.includes('--smoke-test');
// Keep both the data and Chromium Local State (the Windows DPAPI key) at
// their original paths when an existing desktop installation upgrades.
const profile = smoke ? mkdtempSync(path.join(os.tmpdir(), 'creator-smoke-'))
  : path.join(app.getPath('appData'), 'Creator Dashboard Desktop');
if (process.platform !== 'win32') process.umask(0o077);
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.enableSandbox();
const dir = path.join(profile, 'dashboard');
const sessionToken = randomBytes(32).toString('base64url');
let window, tray, server, timer, quitting = false, origin;
let requestedFromWidget = false;
let pendingWidgetRoute = null;
let dashboardLoaded = false;

function openWidgetRoute() {
  if (!dashboardLoaded || pendingWidgetRoute === null || !window || window.isDestroyed()) return;
  const hash = pendingWidgetRoute;
  pendingWidgetRoute = null;
  if (hash && new URL(window.webContents.getURL()).hash !== hash) {
    window.loadURL(origin + '/' + hash).catch(() => {});
  }
  show();
}
const securePreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false };
const externalHosts = new Set(['accounts.google.com', 'console.cloud.google.com', 'myaccount.google.com',
  'developers.google.com', 'support.google.com', 'docs.cloud.google.com', 'appstoreconnect.apple.com', 'developer.apple.com',
  'github.com', 'support.apple.com', 'www.youtube.com', 'studio.youtube.com',
  'pond1982.github.io', 'breakfinderweb.pages.dev', 'easy-tracer-web.pages.dev', 'privacylensweb.pages.dev',
  'pulse-web-5vx.pages.dev', 'puttandpayweb.pages.dev']);

async function openExternal(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !externalHosts.has(url.hostname)) {
    throw new Error('The dashboard cannot open this address.');
  }
  await shell.openExternal(url.href);
  return true;
}

function noPermissions(partition) {
  partition.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  partition.setPermissionCheckHandler(() => false);
}

// Each print has its own local file in an isolated, script-free Chromium session. Report
// strings never enter a shell, and subresources cannot reach the network or disk.
async function renderPdf(html) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'creator-pdf-'));
  const file = path.join(folder, 'report.html');
  const page = pathToFileURL(file).href;
  const printSession = session.fromPartition('creator-report');
  noPermissions(printSession);
  printSession.webRequest.onBeforeRequest((request, next) => next({ cancel: request.resourceType !== 'mainFrame' || request.url !== page }));
  let printWindow, timeout;
  try {
    await writeFile(file, html, { mode: 0o600 });
    printWindow = new BrowserWindow({ show: false, webPreferences: { ...securePreferences, session: printSession, javascript: false } });
    printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    printWindow.webContents.on('will-navigate', event => event.preventDefault());
    const render = async () => {
      await printWindow.loadURL(page);
      const bytes = await printWindow.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4' });
      if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid document.');
      return bytes;
    };
    return await Promise.race([render(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Print timed out.')), 45000);
    })]);
  } catch { throw new Error('The desktop PDF renderer could not complete the report. Try again.'); }
  finally {
    clearTimeout(timeout);
    printWindow?.destroy();
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

function show() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function trayIcon() {
  const mac = process.platform === 'darwin';
  const file = path.join(app.getAppPath(), 'public', mac ? 'argus-pip-tray.png' : 'argus-pip.png');
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error('The Argus Pip tray icon is unavailable.');
  if (mac) {
    image.setTemplateImage(true);
    return image;
  }
  return image.resize({ width: 32, height: 32, quality: 'best' });
}

function installMenus() {
  const loginArgs = process.platform === 'win32' ? { args: ['--background'] } : {};
  const operations = () => [
    { label: 'Open ' + brand, click: show },
    ...(process.platform === 'darwin' && app.isPackaged ? [{
      label: 'Mac widget setup…',
      click: () => dialog.showMessageBox({
        type: 'info', title: 'Argus Pip widget', message: 'Add Argus Pip to your Mac',
        detail: 'Control-click your desktop and choose Edit Widgets, or open Notification Center and choose Edit Widgets. Search for Argus Pip. Choose Subscribers, Latest Upload or App Store Sales, pick a size, then click the preview. Control-click a widget to resize it. On macOS 14 or later, choose Edit Widget on a YouTube widget to pick its channel.',
        buttons: ['Done'],
      }),
    }] : []),
    { label: 'Launch at login', type: 'checkbox', enabled: app.isPackaged,
      checked: app.isPackaged && app.getLoginItemSettings(loginArgs).openAtLogin,
      click: item => {
        try { app.setLoginItemSettings({ ...loginArgs, openAtLogin: item.checked }); }
        catch { dialog.showErrorBox('Launch at login', 'The operating system could not update the login setting.'); }
        rebuild();
      } },
    { type: 'separator' },
    { label: 'Quit ' + brand, accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
  ];
  const rebuild = () => {
    tray.setContextMenu(Menu.buildFromTemplate(operations()));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: brand, submenu: operations() },
      { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
  };
  tray = new Tray(trayIcon());
  tray.setToolTip(brand);
  if (process.platform === 'win32') tray.on('click', show);
  rebuild();
}

async function openDashboard() {
  const appSession = session.fromPartition('creator-ui');
  noPermissions(appSession);
  window = new BrowserWindow({ show: false, width: 1240, height: 850, minWidth: 650, minHeight: 500,
    title: brand, webPreferences: { ...securePreferences, session: appSession } });
  const owner = window.webContents.id;
  const localPage = value => {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' && parsed.origin === origin;
  };
  appSession.webRequest.onBeforeSendHeaders((details, next) => {
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'x-creator-session') delete headers[name];
    if (localPage(details.url) && details.webContentsId === owner) headers['X-Creator-Session'] = sessionToken;
    next({ requestHeaders: headers });
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  const restrictNavigation = (event, url) => {
    if (localPage(url)) return;
    event.preventDefault();
    openExternal(url).catch(() => {});
  };
  window.webContents.on('will-navigate', restrictNavigation);
  window.webContents.on('will-redirect', (event, url) => { if (!localPage(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // Let the OS select a download location; the UI supplies only the PDF name.
  appSession.on('will-download', (event, item, contents) => {
    if (contents.id !== owner || !item.getURL().startsWith('blob:' + origin + '/') || !/\.pdf$/i.test(item.getFilename())) {
      event.preventDefault();
      return;
    }
    const name = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'PDF report', extensions: ['pdf'] }] });
  });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.on('session-end', () => { quitting = true; });
  await window.loadURL(origin + '/');
  dashboardLoaded = true;
  openWidgetRoute();
}

async function smokeTest() {
  trayIcon(); // Verify that the packaged tray artwork can be decoded.
  if (process.platform === 'darwin') {
    const snapshot = JSON.parse(await readFile(path.join(profile, 'widget-snapshot.json'), 'utf8'));
    if (snapshot.version !== 1 || snapshot.sales !== null || snapshot.channels.length !== 0) {
      throw new Error('Widget snapshot initialization failed.');
    }
    if (app.isPackaged) {
      const bridge = createRequire(import.meta.url)(path.join(process.resourcesPath, 'argus-widget-bridge.node'));
      if (typeof bridge.reload !== 'function') throw new Error('The native widget bridge is unavailable.');
      // Verify the module without disturbing the real user's widget timeline.
    }
  }
  // Windows DPAPI is noninteractive. On a developer's Mac, use an ephemeral
  // cipher unless they explicitly select the native Keychain smoke check.
  let cipher = safeStorage;
  if (process.platform !== 'win32' && process.env.CREATOR_DASHBOARD_SMOKE_NATIVE_VAULT !== '1') {
    const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    cipher = {
      isAsyncEncryptionAvailable: async () => true,
      async encryptStringAsync(value) {
        const iv = randomBytes(12);
        const bytes = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(value));
        return Buffer.concat([iv, Buffer.from(bytes)]);
      },
      async decryptStringAsync(bytes) {
        const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
        return { result: Buffer.from(plain).toString() };
      },
    };
  }
  const vault = await createVault(dir, cipher);
  const synthetic = 'synthetic-' + randomBytes(32).toString('hex');
  await vault('set', 'smoke', synthetic);
  const files = await readdir(path.join(dir, 'credentials'));
  const encrypted = await readFile(path.join(dir, 'credentials', files[0]));
  if (encrypted.includes(synthetic) || await vault('get', 'smoke') !== synthetic) throw new Error('Credential roundtrip failed.');
  await vault('set', 'smoke', synthetic + '-rotated');
  if (await vault('get', 'smoke') !== synthetic + '-rotated') throw new Error('Credential replacement failed.');
  await vault('delete', 'smoke');
  if ((await readdir(path.join(dir, 'credentials'))).length) throw new Error('Credential removal failed.');
  const unauth = await fetch(origin + '/api/state');
  const invalid = await fetch(origin + '/api/state', { headers: { 'X-Creator-Session': 'incorrect' } });
  if (unauth.ok || invalid.ok) throw new Error('Session gate failed.');
  const ok = await window.webContents.executeJavaScript(`(async () => {
    for (let i=0;i<120 && document.getElementById('preferences')?.hidden;i++) await new Promise(resolve=>setTimeout(resolve,50));
    const welcome = document.getElementById('preferences');
    if (!welcome || welcome.hidden || typeof require !== 'undefined') return false;
    const response = await fetch('/api/state');
    if (!response.ok) return false;
    const { settings } = await response.json();
    if (settings.onboarded) return false;
    const changed = await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json','X-Dashboard-Request':'1'},
      body:JSON.stringify({...settings,onboarded:true,theme:'daylight',sources:['youtube']}) });
    return changed.ok && (await changed.json()).settings.theme==='daylight';
  })()`);
  if (!ok) throw new Error('Chromium onboarding failed.');
  const id = 'UC' + 'x'.repeat(22);
  const { html } = reportDocument({ youtube: { updatedAt: '2026-01-01T00:00:00Z', data: [{ id, title: 'Sample channel', videos: [] }] } },
    { source: 'youtube', channelId: id });
  await renderPdf(html);
  const result = process.env.CREATOR_DASHBOARD_SMOKE_RESULT;
  if (result) await writeFile(result, 'ok\n', { flag: 'wx', mode: 0o600 });
  console.log('Argus Pip packaged smoke test passed.');
}

async function start() {
  // Electron 45 sets the macOS Keychain identity from package.json during its
  // native initialization. Change the display name only after app.whenReady().
  app.setName(brand);
  if (!smoke && !['darwin', 'win32'].includes(process.platform)) throw new Error('Argus Pip supports macOS and Windows.');
  if (!smoke && process.platform === 'darwin') {
    const proceed = await offerMacImport({ dir, legacyDir, encryption: safeStorage, dialog, legacyGet: account => keychain('get', account) });
    if (!proceed) { app.quit(); return; }
  }
  const vault = await createVault(dir, safeStorage);
  const dashboard = await createDashboard({ dir, vault });
  const analytics = await createAnalytics({ dir, vault, redirectUri: () => origin });
  const settings = await openSettings(dir, dashboard.state());
  let publishWidget = async () => {};
  let publicDashboard = dashboard, publicAnalytics = analytics, publicSettings = settings;
  if (process.platform === 'darwin') {
    let reload;
    if (app.isPackaged && !smoke) {
      try {
        const bridge = createRequire(import.meta.url)(path.join(process.resourcesPath, 'argus-widget-bridge.node'));
        reload = () => bridge.reload();
      } catch { /* WidgetKit's own timeline also reads the snapshot. */ }
    }
    const publish = widgetPublisher({
      file: path.join(profile, 'widget-snapshot.json'), reload,
      readSnapshot: () => {
        const preferences = settings.get();
        const state = dashboard.state({ includeDailySales: preferences.onboarded && preferences.sources.includes('apple') });
        const ids = preferences.sources.includes('youtube')
          ? (state.youtube.data ?? []).map(channel => channel.id).filter(id => preferences.visibleChannelIds?.includes(id) ?? true) : [];
        return widgetSnapshot(state, preferences, analytics.state(ids));
      },
    });
    publishWidget = () => publish().catch(() => { console.error('Could not update the local widget snapshot.'); });
    // Publish on the same operations as the dashboard, including an OAuth
    // callback and a preference change. No separate polling job is needed.
    const afterChanges = (source, methods) => {
      const wrapped = { ...source };
      for (const method of methods) {
        wrapped[method] = async (...args) => {
          try { return await source[method](...args); }
          finally { await publishWidget(); }
        };
      }
      return wrapped;
    };
    publicDashboard = afterChanges(dashboard, ['sync']);
    publicAnalytics = afterChanges(analytics, ['callback', 'refresh']);
    publicSettings = afterChanges(settings, ['save']);
    await publishWidget();
  }
  server = await makeServer(publicDashboard, 0, publicAnalytics, publicSettings, { sessionToken, getOrigin: () => origin, renderPdf, openExternal });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  if (!smoke) installMenus();
  await openDashboard();
  if (smoke) { await smokeTest(); window.destroy(); server.close(); app.quit(); return; }
  const startedAtLogin = app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
  if (requestedFromWidget || (!process.argv.includes('--background') && !startedAtLogin)) show();
  let updating = false;
  async function tick() {
    if (updating) return;
    updating = true;
    try {
      await dashboard.tick(settings.get().sources);
      const ids = settings.get().sources.includes('youtube') ? (dashboard.state().youtube.data ?? []).map(c => c.id) : [];
      await analytics.tick(ids);
    } catch { /* Per-source state retains actionable errors; the next tick retries. */ }
    finally { await publishWidget(); updating = false; }
  }
  tick();
  timer = setInterval(tick, 60000);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('open-url', (event, url) => {
    const route = widgetRoute(url);
    if (route === null) return;
    event.preventDefault();
    requestedFromWidget = true;
    pendingWidgetRoute = route;
    openWidgetRoute();
  });
  app.on('second-instance', show);
  app.on('activate', show);
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; clearInterval(timer); server?.close(); });
  if (smoke) process.on('exit', () => {
    // Profile is private and disposable; Chromium may still own files during Windows shutdown.
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  });
  app.whenReady().then(start).catch(error => {
    if (smoke) { console.error('Desktop smoke test failed:', error.message); app.exit(1); }
    else {
      const message = error.message.startsWith('The previous setup could not be imported') ? error.message :
        'Argus Pip could not start. Check that your user data folder is writable and reopen the app.';
      dialog.showErrorBox(brand, message);
      app.exit(1);
    }
  });
}
