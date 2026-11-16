import { element } from './ui.js';

export const defaultSettings = state => ({
  onboarded: Boolean(state.youtube?.configured || state.apple?.configured),
  sources: ['youtube', 'apple'],
  theme: 'midnight',
  visibleChannelIds: null
});

export function applyTheme(theme, remember = false) {
  document.documentElement.dataset.theme = theme;
  if (remember) {
    try { localStorage.setItem('creator-dashboard.theme', theme); } catch {}
  }
}

export function settingsForm({ getState, save, finish }) {
  const get = id => document.getElementById(id);
  const form = get('preferences-form');
  const visibleList = get('visible-list');
  const showAll = get('show-all');
  const feedback = get('settings-feedback');
  const saveButton = get('save-preferences');
  let hiddenIds, channels = [], busy = false, editing = false;

  function updateVisibility() {
    const hasYouTube = form.elements.sources.value !== 'apple';
    get('visibility-options').hidden = !hasYouTube || !channels.length;
    for (const input of visibleList.querySelectorAll('input')) {
      input.disabled = showAll.checked;
      input.checked = showAll.checked || !hiddenIds.has(input.value);
    }
  }

  function open() {
    const state = getState();
    const settings = state.settings;
    const welcome = !settings.onboarded;
    editing = true;
    feedback.replaceChildren();
    get('preferences-title').textContent = welcome ? 'Set up your dashboard' : 'Dashboard settings';
    get('preferences-lead').textContent = welcome ? 'Choose what to track on this device.' : 'Choose your sources, appearance and visible channels.';
    saveButton.textContent = welcome ? 'Continue to connections' : 'Save settings';
    form.elements.sources.value = settings.sources.length === 2 ? 'both' : settings.sources[0];
    form.elements.theme.value = settings.theme;
    channels = state.youtube?.data || [];
    hiddenIds = new Set(settings.visibleChannelIds === null ? [] : channels.map(c => c.id).filter(id => !settings.visibleChannelIds.includes(id)));
    showAll.checked = settings.visibleChannelIds === null;
    visibleList.replaceChildren();
    for (const channel of channels) {
      const label = element('label', 'toggle-choice');
      const input = element('input');
      input.type = 'checkbox';
      input.value = channel.id;
      input.addEventListener('change', () => {
        if (input.checked) hiddenIds.delete(input.value);
        else hiddenIds.add(input.value);
      });
      label.append(input, document.createTextNode(channel.title));
      visibleList.append(label);
    }
    updateVisibility();
    applyTheme(settings.theme);
  }

  form.addEventListener('change', event => {
    if (event.target.name === 'theme') applyTheme(form.elements.theme.value);
    if (event.target === showAll || event.target.name === 'sources') updateVisibility();
    feedback.replaceChildren();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const old = getState().settings;
    const selection = form.elements.sources.value;
    const sources = selection === 'both' ? ['youtube', 'apple'] : [selection];
    const visibleChannelIds = !channels.length ? old.visibleChannelIds
      : showAll.checked ? null : channels.filter(c => !hiddenIds.has(c.id)).map(c => c.id);
    const next = { onboarded: true, sources, theme: form.elements.theme.value, visibleChannelIds };
    busy = true;
    saveButton.disabled = true;
    feedback.textContent = 'Saving…';
    try {
      await save(next);
      applyTheme(next.theme, true);
      editing = false;
      finish(old, next);
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      busy = false;
      saveButton.disabled = false;
    }
  });

  return {
    open,
    close() {
      if (editing) applyTheme(getState().settings.theme);
      editing = false;
    }
  };
}

export function channelFields(markEdited) {
  const wrap = document.getElementById('channel-inputs');
  const add = document.getElementById('add-channel');
  const inputs = () => [...wrap.querySelectorAll('input')];
  function labelRows() {
    for (const [i, row] of [...wrap.children].entries()) {
      const input = row.querySelector('input');
      const label = row.querySelector('label');
      const remove = row.querySelector('button');
      input.id = 'channel-' + (i + 1);
      label.htmlFor = input.id;
      label.textContent = 'Channel ' + (i + 1);
      remove.disabled = wrap.children.length < 2;
      remove.setAttribute('aria-label', 'Remove channel ' + (i + 1));
    }
  }
  function addRow(value = '') {
    const row = element('div', 'channel-entry');
    const label = element('label');
    const input = element('input');
    input.type = 'text';
    input.required = true;
    input.spellcheck = false;
    input.placeholder = '@handle or channel URL';
    input.value = value;
    const remove = element('button', 'button remove-channel', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      const focus = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      labelRows();
      markEdited();
      focus?.querySelector('input').focus();
    });
    row.append(label, input, remove);
    wrap.append(row);
    return input;
  }
  add.addEventListener('click', () => {
    const input = addRow();
    labelRows();
    markEdited();
    input.focus();
  });
  return {
    values: () => inputs().map(input => input.value.trim()),
    set(values) {
      const wanted = values?.length ? values : [''];
      if (JSON.stringify(wanted) === JSON.stringify(inputs().map(input => input.value))) return;
      wrap.replaceChildren();
      for (const v of wanted) addRow(v);
      labelRows();
    }
  };
}
