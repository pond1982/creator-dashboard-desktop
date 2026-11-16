import { element, link, notice, timestamp } from './ui.js';
import { channelTabs, renderChannel } from './youtube-view.js';
import { applyTheme, settingsForm, defaultSettings, channelFields } from './settings.js';
import { studio } from './studio-view.js';
import { ranges, salesHeader, renderSales, reportFilters } from './sales-view.js';

const id = name => document.getElementById(name);
const pending = { youtube: false, apple: false };
const actionErrors = { youtube: '', apple: '' };
const edited = { youtube: false, apple: false };
const preferences = { currency: '', order: 'proceeds', videoOrder: 'newest' };
const periods = new Map();
const studioActions = new Map();
let callbackError = null;
const periodErrors = new Map();
const exportsInProgress = new Set();
const exportErrors = new Map();
let state, periodRequest, readingState = 0;
let channelId = '', days = 7, source = 'youtube', setup = false;
let periodVersion = 0;
let showingPreferences = false;
const fields = channelFields(() => { edited.youtube = true; });
const userSettings = settingsForm({
  getState: () => state,
  save: settings => requestJSON('/api/settings', settings),
  finish(old, settings) {
    state.settings = settings;
    const next = settings.sources.find(name => !state[name].configured);
    const target = next ? '#connections/' + next : '#' + (settings.sources.includes(source) ? source : settings.sources[0]);
    if (location.hash === target) route();
    else location.hash = target;
    id('announcer').textContent = old.onboarded ? 'Dashboard settings saved.' : 'Dashboard created.';
  }
});

function updateForms() {
  for (const source of ['youtube', 'apple']) {
    const record = state[source];
    const awaitingReports = source === 'apple' && record.configured && record.data?.reportedDays === 0 && record.data?.comparisonReportedDays === 0;
    id(source + '-configured').textContent = awaitingReports ? 'Settings saved. Waiting for an Apple report.' : record.configured
      ? (source === 'youtube' ? 'Connected. Leave the API key blank to reuse the saved key.' : 'Connected. Enter the credentials below to replace this connection.')
      : source === 'youtube' ? 'One API key covers your public channels.' : 'Connect the apps under one vendor number.';
    const button = id(source + '-form').querySelector('button[type="submit"]');
    button.disabled = Boolean(state.busy?.[source]) || pending[source];
    button.textContent = pending[source] ? 'Connecting…' : state.busy?.[source] ? 'Updating…' : record.configured
      ? 'Update connection' : source === 'youtube' ? 'Connect channels' : 'Connect app sales';
  }
  id('api-key').required = !state.youtube.configured;
  if (!edited.youtube) fields.set(state.youtube.inputs);
  if (!edited.apple) {
    id('key-id').value = state.apple.keyId || '';
    id('issuer-id').value = state.apple.issuerId || '';
    id('vendor-number').value = state.apple.vendorNumber || '';
  }
}

async function connect(event, source) {
  event.preventDefault();
  if (pending[source]) return;
  const message = id(source + '-feedback');
  const button = event.target.querySelector('button[type="submit"]');
  pending[source] = true;
  button.disabled = true;
  button.textContent = 'Connecting…';
  message.classList.remove('failed');
  message.textContent = source === 'apple' ? 'Checking the key and downloading available reports…' : 'Checking your key and channels…';
  let saved = false;
  try {
    let body;
    if (source === 'youtube') {
      body = { apiKey: id('api-key').value.trim(), inputs: fields.values() };
    } else {
      const file = id('private-key').files[0];
      if (!file || file.size > 16384) throw new Error('Choose the .p8 private key file downloaded from Apple.');
      body = { keyId: id('key-id').value.trim(), issuerId: id('issuer-id').value.trim(), vendorNumber: id('vendor-number').value.trim(), privateKey: await file.text() };
    }
    await requestJSON('/api/setup/' + source, body);
    id(source === 'youtube' ? 'api-key' : 'private-key').value = '';
    edited[source] = false;
    actionErrors[source] = '';
    saved = true;
    message.textContent = 'Settings saved.';
  } catch (error) {
    message.classList.add('failed');
    message.textContent = error.message;
  } finally {
    pending[source] = false;
    button.disabled = false;
    button.textContent = source === 'youtube' ? 'Connect channels' : 'Connect app sales';
    await loadState();
    if (state) { render(); updateForms(); }
    if (saved) {
      const reports = state?.apple?.data;
      const waiting = source === 'apple' && reports?.reportedDays === 0 && reports?.comparisonReportedDays === 0;
      message.replaceChildren(document.createTextNode(waiting ? 'Settings saved. Waiting for an Apple report. ' : 'Settings saved. '), link('View dashboard →', '#' + source));
      const next = state?.settings.sources.find(other => other !== source && !state[other].configured);
      if (next) message.append(document.createTextNode(' · '), link('Connect ' + (next === 'apple' ? 'App Store Connect' : 'YouTube') + ' →', '#connections/' + next));
    }
  }
}

for (const source of ['youtube', 'apple']) {
  id(source + '-form').addEventListener('input', () => { edited[source] = true; });
  id(source + '-form').addEventListener('submit', event => connect(event, source));
}

function route() {
  if (!state) return;
  if (location.hash === '#main') { id('main').focus(); return; }
  const saved = state.settings;
  document.querySelector('.brand').href = '#' + (saved.sources.includes(source) ? source : saved.sources[0]);
  const prefs = !saved.onboarded || location.hash === '#settings';
  id('nav-settings').hidden = !saved.onboarded;
  id('nav-connections').hidden = !saved.onboarded;
  id('source-tabs').hidden = prefs;
  id('source-tabs').classList.toggle('single-source', saved.sources.length === 1);
  id('preferences').hidden = !prefs;
  if (prefs) {
    if (!showingPreferences) userSettings.open();
    showingPreferences = true;
    id('overview').hidden = true;
    id('connections').hidden = true;
    id('nav-settings').setAttribute('aria-current', 'page');
    id('nav-connections').removeAttribute('aria-current');
    document.title = (saved.onboarded ? 'Settings' : 'Welcome') + ' · Creator Dashboard';
    return;
  }
  if (showingPreferences) userSettings.close();
  showingPreferences = false;
  id('nav-settings').removeAttribute('aria-current');
  const [page, value, section] = location.hash.slice(1).split('/');
  callbackError = null;
  if (page === 'analytics-error') {
    try { callbackError = decodeURIComponent(value || 'Could not connect to Google.'); }
    catch { callbackError = 'Could not connect to Google.'; }
  }
  setup = page === 'connections';
  source = page === 'apple' || (setup && value === 'apple') ? 'apple' : 'youtube';
  if (!saved.sources.includes(source)) {
    source = saved.sources[0];
    if (page !== 'analytics-error') history.replaceState(null, '', setup ? '#connections/' + source : '#' + source);
  }
  if (!setup && page === 'youtube' && value && source === 'youtube') channelId = value;
  if (!setup && page === 'apple' && ranges.includes(Number(value))) days = Number(value);
  id('overview').hidden = setup;
  id('connections').hidden = !setup;
  if (setup && section === 'studio') requestAnimationFrame(() => id('studio-setup').scrollIntoView({block:'start'}));
  id('nav-connections').toggleAttribute('aria-current', setup);
  if (setup) id('nav-connections').setAttribute('aria-current', 'page');
  for (const name of ['youtube', 'apple']) {
    const enabled = saved.sources.includes(name);
    id('source-' + name).hidden = !enabled;
    id('tab-' + name).hidden = !enabled;
    id('setup-' + name).hidden = name !== source;
    for (const [prefix, active] of [['tab-', setup], ['source-', !setup]]) {
      const node = id(prefix + name);
      if (name === source && active) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
  }
  id('nav-connections').href = '#connections/' + source;
  render();
}

function disconnected(name) {
  const yt = name === 'youtube';
  const box = element('section', 'empty-block panel');
  box.append(element('h1', '', yt ? 'Connect your channels' : 'Connect your app sales'),
    element('p', 'subtitle', yt ? 'Add your channels to see public videos, subscriber counts and publishing activity.' : 'Connect App Store Connect to compare downloads, in-app purchases and estimated proceeds.'),
    link(yt ? 'Set up YouTube →' : 'Set up app sales →', '#connections/' + name, 'button primary'));
  return box;
}

const keyForExport = options => JSON.stringify(options);
function actions(name, options, fallback) {
  const box = element('div', 'header-actions');
  const buttons = element('div', 'actions');
  const refresh = element('button', 'button icon-button', '↻');
  refresh.title = 'Refresh ' + (name === 'apple' ? 'sales' : 'channels');
  refresh.setAttribute('aria-label', refresh.title);
  refresh.disabled = Boolean(pending[name] || state.busy?.[name] || (name === 'apple' && periodRequest));
  refresh.addEventListener('click', () => refreshSource(name));
  const key = keyForExport(options);
  const pdf = element('button', 'button primary', exportsInProgress.has(key) ? 'Creating PDF…' : '↓  Export PDF');
  pdf.disabled = !options || exportsInProgress.has(key);
  pdf.dataset.focus = 'Export PDF';
  pdf.addEventListener('click', () => downloadReport(options, fallback));
  buttons.append(refresh, pdf);
  const label = pending[name] || state.busy?.[name] ? 'Updating…' : state[name].updatedAt ? 'Updated ' + timestamp(state[name].updatedAt) : 'Waiting for first update';
  box.append(buttons, element('span', 'sync-label', label));
  return box;
}

async function downloadReport(options, fallback) {
  if (!options) return;
  const key = keyForExport(options);
  if (exportsInProgress.has(key)) return;
  exportsInProgress.add(key);
  exportErrors.delete(key);
  render();
  try {
    const response = await post('/api/report', options);
    if (!response.ok || !response.headers.get('Content-Type')?.includes('application/pdf')) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Could not create the PDF. Try again.');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    let name = fallback + '.pdf';
    const utfName = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const plainName = /filename="([^"]+)"/i.exec(disposition);
    if (utfName) {
      try { name = decodeURIComponent(utfName[1]); } catch {}
    } else if (plainName) name = plainName[1];
    const url = URL.createObjectURL(blob);
    const a = link('', url);
    a.download = name.replace(/[/\\:*?"<>|]/g, '-');
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    id('announcer').textContent = 'Report downloaded.';
  } catch (error) {
    exportErrors.set(key, error.message);
  } finally {
    exportsInProgress.delete(key);
    render();
  }
}

function post(path, body) {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Request': '1' }, body: JSON.stringify(body) });
}

async function requestJSON(path, body) {
  const response = await post(path, body);
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error || !(result.ok || result.report || result.url || result.settings)) throw new Error(result.error || 'The request failed. Check that the local dashboard is running.');
  return result;
}

function invalidatePeriods() {
  periodVersion++;
  periods.clear();
  periodErrors.clear();
}

async function loadPeriod(span) {
  if (periodRequest || !state?.apple.configured || span === 7) return;
  const version = periodVersion;
  periodRequest = { span };
  try {
    const { report } = await requestJSON('/api/apple/period', { days: span });
    if (!report || report.days !== span) throw new Error('The server returned a different reporting period. Try again.');
    if (version === periodVersion) periods.set(span, report);
  } catch (error) {
    if (version === periodVersion) periodErrors.set(span, error.message);
  } finally {
    periodRequest = null;
    render();
  }
}

function render() {
  if (showingPreferences) return;
  if (setup) { document.title = 'Connections · Creator Dashboard'; return; }
  if (!state) return;
  const focus = document.activeElement?.dataset.focus;
  const box = id('workspace');
  box.replaceChildren();
  const record = state[source];
  if (callbackError) {
    const alert = notice(callbackError, true);
    if (state.settings.sources.includes('youtube')) {
      alert.append(document.createTextNode(' '), link('Back to channels', '#youtube'), document.createTextNode(' · '), link('Check Google setup', '#connections/youtube/studio'));
    } else {
      alert.append(document.createTextNode(' '), link('Enable YouTube in Settings', '#settings'));
    }
    box.append(alert);
  }
  const error = actionErrors[source] || record.error;
  if (error) box.append(notice((record.data ? 'Last update failed. ' : '') + error, true));
  const title = source === 'youtube' ? 'YouTube' : 'App Store Connect';
  document.title = title + ' · Creator Dashboard';
  if (!record.configured) { box.append(disconnected(source)); return; }
  let reportOptions;
  if (source === 'youtube' && record.data?.length) {
    const visible = state.settings.visibleChannelIds;
    const channels = visible === null ? record.data : record.data.filter(channel => visible.includes(channel.id));
    if (!channels.length) {
      const empty = element('section', 'panel empty-block');
      empty.append(element('h1', '', 'No channels selected'), element('p', 'subtitle', 'Choose which connected channels to show.'), link('Choose visible channels →', '#settings', 'button primary'));
      box.append(empty);
      return;
    }
    const selected = channels.find(channel => channel.id === channelId) || channels[0];
    if (location.hash.startsWith('#youtube/') && channelId !== selected.id) history.replaceState(null, '', '#youtube/' + encodeURIComponent(selected.id));
    channelId = selected.id;
    id('source-youtube').href = '#youtube/' + encodeURIComponent(channelId);
    document.title = selected.title + ' · Creator Dashboard';
    reportOptions = { source, channelId, videoSort: preferences.videoOrder, updatedAt: record.updatedAt };
    box.append(channelTabs(channels, channelId));
    const sid = selected.id;
    const panel = studio(sid, state.analytics, { ...studioActions.get(sid), run: action => studioAction(sid, action) });
    renderChannel(box, selected, actions(source, reportOptions, selected.title), preferences.videoOrder, sort => { preferences.videoOrder = sort; render(); }, panel);
  } else if (source === 'apple') {
    id('source-apple').href = '#apple/' + days;
    const report = days === 7 ? record.data : periods.get(days);
    const filters = reportFilters(report, preferences);
    if (report) reportOptions = { source, days, currency: filters.currency, order: filters.order, updatedAt: record.updatedAt };
    box.append(salesHeader(days, actions(source, reportOptions, 'App sales ' + days + ' days'), report));
    if (report) {
      renderSales(box, report, filters, (key, value) => { preferences[key] = value; render(); });
    } else if (periodErrors.has(days)) {
      const error = notice(periodErrors.get(days), true);
      const retry = element('button', 'button small', 'Retry period');
      retry.addEventListener('click', () => { periodErrors.delete(days); render(); });
      box.append(error, retry);
    } else if (days !== 7) {
      if (!periodRequest) loadPeriod(days);
      box.append(notice(periodRequest?.span === days
        ? 'Loading ' + days + ' days and the comparison period. The first download can take a few minutes.'
        : 'Waiting for the current report download to finish…'));
    } else box.append(notice('Waiting for the first sales report.'));
  } else {
    box.append(actions(source, null, ''), notice('Waiting for the first channel update.'));
  }
  const pdfError = exportErrors.get(keyForExport(reportOptions));
  if (pdfError) box.prepend(notice(pdfError, true));
  if (focus) [...box.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === focus)?.focus({ preventScroll: true });
}

async function loadState() {
  const request = ++readingState;
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const next = await response.json();
    if (request !== readingState) return;
    id('service-error').hidden = true;
    const old = state;
    next.settings ??= defaultSettings(next);
    state = next;
    const changedSettings = !old || JSON.stringify(old.settings) !== JSON.stringify(next.settings);
    if (changedSettings) {
      if (showingPreferences) userSettings.open();
      applyTheme(next.settings.theme, true);
      route();
    }
    for (const name of ['youtube', 'apple']) {
      if (old && next[name].updatedAt !== old[name].updatedAt && !next[name].error) actionErrors[name] = '';
    }
    if (old && (old.apple.updatedAt !== next.apple.updatedAt || old.apple.keyId !== next.apple.keyId || old.apple.vendorNumber !== next.apple.vendorNumber)) invalidatePeriods();
    for (const [channel, record] of Object.entries(next.analytics?.channels || {})) {
      if (record.connected && record.updatedAt && record.updatedAt !== old?.analytics?.channels?.[channel]?.updatedAt) studioActions.delete(channel);
    }
    id('client-status').textContent = next.analytics?.clientConfigured ? 'Client saved securely on this device. Each channel has its own consent.' : 'Save one desktop client for your channels.';
    if (!old || JSON.stringify(old.analytics) !== JSON.stringify(next.analytics) || JSON.stringify(old[source]) !== JSON.stringify(next[source]) || old.busy?.[source] !== next.busy?.[source]) render();
    updateForms();
  } catch {
    if (request !== readingState) return;
    id('service-error').textContent = 'Can’t reach the local dashboard. Reopen Creator Dashboard and try again.';
    id('service-error').hidden = false;
  }
}

async function refreshSource(name) {
  if (pending[name]) return;
  pending[name] = true;
  actionErrors[name] = '';
  render();
  try {
    await requestJSON('/api/refresh', { source: name });
    if (name === 'apple') invalidatePeriods();
    id('announcer').textContent = 'Refresh completed.';
  } catch (error) {
    actionErrors[name] = error.message;
  } finally {
    pending[name] = false;
    await loadState();
    render();
  }
}

async function studioAction(sid, action) {
  if (studioActions.get(sid)?.busy) return;
  studioActions.set(sid, { busy: true });
  render();
  try {
    const result = await requestJSON('/api/analytics/' + action, {channelId: sid});
    if (action === 'connect') {
      const url = new URL(result.url);
      if (url.origin !== 'https://accounts.google.com') throw new Error('The server returned an invalid Google sign-in address.');
      studioActions.set(sid, { url: url.href });
    } else studioActions.delete(sid);
    await loadState();
  } catch (error) { studioActions.set(sid, { error: error.message }); }
  finally { render(); }
}

id('client-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = id('client-file').files[0];
  const message = id('client-feedback');
  const button = id('client-form').querySelector('button[type="submit"]');
  button.disabled = true;
  message.classList.remove('failed');
  message.textContent = 'Saving the client…';
  try {
    if (!file || file.size > 65536) throw new Error('Choose the desktop OAuth client JSON from Google.');
    let installed;
    try { installed = JSON.parse(await file.text()).installed; } catch {}
    if (!installed?.client_id || !installed?.client_secret) throw new Error('Choose a Desktop app OAuth client JSON with a client ID and client secret.');
    await requestJSON('/api/analytics/client', {clientId: installed.client_id, clientSecret: installed.client_secret});
    id('client-file').value = '';
    message.replaceChildren(document.createTextNode('Google client saved. '), link('Choose a channel →', '#youtube'));
    await loadState();
  } catch (error) {
    message.classList.add('failed');
    message.textContent = error.message;
  } finally { button.disabled = false; }
});

window.addEventListener('hashchange', route);
window.addEventListener('focus', loadState);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadState(); });
route();
loadState();
setInterval(() => { if (!document.hidden) loadState(); }, 30000);
