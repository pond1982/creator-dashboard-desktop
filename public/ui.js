export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function link(label, url, className, external = false) {
  const a = element('a', className, label);
  a.href = url;
  if (external) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  return a;
}

export const count = n => Number.isFinite(n) ? n.toLocaleString() : '—';
export const day = (iso, short = false) => {
  if (!iso) return '—';
  const date = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(short ? {} : { year: 'numeric' }) });
};
export const timestamp = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const money = (n, currency) => Number.isFinite(n) && currency
  ? new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(n) : '—';

export function notice(text, error = false) {
  const p = element('p', error ? 'notice error' : 'notice', text);
  p.setAttribute('role', error ? 'alert' : 'status');
  return p;
}

export function control(label, options, value, change) {
  const wrap = element('label', 'filter', label);
  const select = element('select');
  for (const [key, text] of options) {
    const option = element('option', '', text);
    option.value = key;
    select.append(option);
  }
  select.value = value;
  select.dataset.focus = label;
  select.addEventListener('change', () => change(select.value));
  wrap.append(select);
  return wrap;
}

export function metric(label, value, detail) {
  const block = element('div', 'metric');
  block.append(element('dt', '', label), element('dd', '', value));
  if (detail) block.append(element('span', 'detail', detail));
  return block;
}

export function tableFrame(label, columns) {
  const scroll = element('div', 'table-scroll');
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', label);
  scroll.tabIndex = 0;
  const table = element('table');
  table.append(element('caption', 'sr-only', label));
  const head = element('thead');
  const row = element('tr');
  for (const c of columns) {
    const th = element('th', '', c);
    th.scope = 'col';
    row.append(th);
  }
  head.append(row);
  const body = element('tbody');
  table.append(head, body);
  scroll.append(table);
  return { scroll, body };
}

export function photo(url, className) {
  if (!url) return null;
  const img = element('img', className);
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => img.remove(), { once: true });
  img.src = url;
  return img;
}
