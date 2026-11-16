const channels = [
  { name: 'Orbit Sketchbook', base: 930, subscribers: 24360, minutes: 4.6, video: 'The sketchbook I keep coming back to' },
  { name: 'Fern & Frame', base: 1460, subscribers: 37620, minutes: 5.8, video: 'Filming a forest before sunrise' },
  { name: 'Little Signal Lab', base: 640, subscribers: 15890, minutes: 3.7, video: 'Building a tiny field recorder' },
];
const apps = [
  { name: 'Paper Kite', units: 26, price: 2.99 },
  { name: 'Minute Orchard', units: 18, price: 4.99 },
  { name: 'Pocket Tides', units: 12, price: 1.99 },
];

// A repeatable fictional series lets the day, week, and channel views reconcile.
const initialDay = 84;
const oneDay = 86400000;
const today = new Date();
const epoch = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - (initialDay + 1) * oneDay;
const calendar = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateLabel = day => calendar.format(epoch + day * oneDay);
const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const abbreviated = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

function dailySignal(day, seed) {
  const wave = Math.sin(day * 0.42 + seed) * 0.19 + Math.cos(day * 0.89 + seed) * 0.09;
  const noise = Math.sin(day * 74.73 + seed * 41.51) * 343.17;
  return 0.65 + day * 0.007 + wave + (noise - Math.floor(noise) - 0.5) * 0.27;
}

function youtubeDay(day, index) {
  const channel = channels[index];
  const views = Math.max(30, Math.round(channel.base * dailySignal(day, index + 1)));
  const gained = Math.round(views * (0.012 + 0.005 * Math.sin(day * 0.3 + index)));
  const lost = Math.round(views * (0.002 + 0.001 * Math.cos(day * 0.23)));
  const minutesPerView = channel.minutes * (1 + Math.sin(day * 0.23 + index) * 0.16);
  return { day, views, net: gained - lost, hours: views * minutesPerView / 60 };
}

function appleDay(day, selected) {
  const row = { day, paid: 0, iap: 0, proceeds: 0 };
  for (const [index, app] of apps.entries()) {
    if (selected !== 'all' && Number(selected) !== index) continue;
    const units = Math.max(0, Math.round(app.units * dailySignal(day, index + 5)));
    const iap = Math.round(units * (0.21 + 0.11 * Math.sin(day + index)));
    row.paid += units;
    row.iap += iap;
    row.proceeds += Math.round((units * app.price + iap * 1.99) * 0.85 * 100) / 100;
  }
  return row;
}

const iconPaths = {
  chart: '<path d="m3 17 4-4 3 2 5-7 3 2 3-5"/><path d="M3 4v16h18"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 .1 8M20 3v5h-5"/>',
  youtube: '<rect x="2" y="5" width="20" height="14" rx="4" fill="currentColor" stroke="none"/><path d="m10 9 5 3-5 3z" fill="#201c2d" stroke="none"/>',
  apple: '<path d="M3 20h18M6 15v-4m6 4V4m6 11V8"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  arrow: '<path d="m5 16 12-9m-7 0h7v7"/>',
  play: '<path d="m8 5 11 7L8 19z" fill="currentColor" stroke="none"/>',
};
function icon(name) {
  return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + iconPaths[name] + '</svg>';
}

const metricNames = { views: 'Views', net: 'Net subscribers', paid: 'Paid downloads', proceeds: 'Est. proceeds' };
function formatMetric(metric, value, compact = false) {
  if (metric === 'proceeds') return dollars.format(value);
  return compact ? abbreviated.format(value) : amount.format(value);
}

class ArgusDemo extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.source = 'youtube';
    this.channel = '0';
    this.appleApp = 'all';
    this.days = 28;
    this.periods = { youtube: 28, apple: 7 };
    this.end = initialDay;
    this.subscriberCounts = channels.map(channel => channel.subscribers);
    this.metrics = { youtube: 'views', apple: 'paid' };
    this.selectedPoint = null;
  }

  connectedCallback() {
    if (this.shadowRoot.firstElementChild) { this.scheduleRefresh(); return; }
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = new URL('./demo.css', import.meta.url).href;
    this.shadowRoot.append(style);
    const section = document.createElement('section');
    section.className = 'window';
    section.setAttribute('aria-label', 'Argus Pip interactive sample dashboard');
    section.innerHTML = `
      <header class="window-bar">
        <span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="window-name">Argus Pip</span>
        <span class="sample-label"><i aria-hidden="true"></i> Fictional data</span>
      </header>
      <div class="workspace">
        <div class="source-bar">
          <span class="nav-caption">Sources</span>
          <div class="source-switch" role="group" aria-label="Sample data source">
            <button type="button" data-source="youtube">${icon('youtube')}YouTube</button>
            <button type="button" data-source="apple">${icon('apple')}App Store</button>
          </div>
          <div class="refresh-actions">
            <button type="button" class="refresh" aria-label="Refresh sample data and advance one day" title="Refresh sample data and advance one day">${icon('refresh')}<span>Refresh sample</span></button>
            <label class="auto" title="Advance the fictional sample by one day every 25 seconds"><input type="checkbox" aria-label="Auto-refresh fictional data every 25 seconds">Auto-refresh</label>
          </div>
        </div>
        <div class="overview-line">
          <label class="picker"><span class="picker-caption"></span><span class="select-wrap"><select></select>${icon('down')}</span></label>
          <div class="range-switch" role="group" aria-label="Sample reporting period">
            <button type="button" data-days="7" aria-label="Last 7 days">7d</button>
            <button type="button" data-days="28" aria-label="Last 28 days">28d</button>
          </div>
        </div>
        <div class="cards"></div>
        <div class="chart-card">
          <div class="chart-head">
            <div><h3 class="chart-title"></h3><p class="chart-dates"></p></div>
            <div class="metric-switch" role="group" aria-label="Sample chart metric">
              <button type="button"></button><button type="button"></button>
            </div>
          </div>
          <div class="graph">
            <div class="ticks" aria-hidden="true"><span></span><span></span><span></span></div>
            <div class="plot" role="slider" tabindex="0" aria-label="Explore daily sample data" aria-orientation="horizontal" aria-valuemin="1">
              <svg viewBox="0 0 600 116" preserveAspectRatio="none" aria-hidden="true">
                <defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#bb9aff" stop-opacity=".34"/><stop offset="100%" stop-color="#bb9aff" stop-opacity=".01"/></linearGradient></defs>
                <g class="grid"><path d="M0 4h600M0 58h600M0 112h600"/></g>
                <path class="area" fill="url(#area)"/><path class="line" fill="none"/>
              </svg>
              <div class="cursor" aria-hidden="true"><i></i></div>
              <output class="point-tip" aria-hidden="true"></output>
            </div>
            <div class="x-axis" aria-hidden="true"><span></span><span></span><span></span></div>
          </div>
        </div>
        <div class="activity"><span class="activity-icon" aria-hidden="true"></span><div><small></small><strong></strong></div><span class="activity-value"></span></div>
      </div>
      <span class="sr-only" role="status" aria-live="polite"></span>`;
    this.shadowRoot.append(section);
    this.ui = selector => section.querySelector(selector);
    section.addEventListener('click', event => this.handleClick(event));
    this.ui('.auto input').addEventListener('change', () => this.scheduleRefresh());
    this.ui('select').addEventListener('change', event => {
      if (this.source === 'youtube') this.channel = event.target.value;
      else this.appleApp = event.target.value;
      this.update('Selection changed.');
    });
    const plot = this.ui('.plot');
    plot.addEventListener('pointermove', event => {
      if (event.pointerType !== 'touch') this.pointAt(event);
    });
    plot.addEventListener('pointerdown', event => this.pointAt(event));
    plot.addEventListener('pointerleave', () => {
      if (this.shadowRoot.activeElement !== plot) this.highlight(null);
    });
    plot.addEventListener('focus', () => this.highlight(this.selectedPoint ?? this.days - 1));
    plot.addEventListener('blur', () => this.highlight(null));
    plot.addEventListener('keydown', event => {
      const current = this.selectedPoint ?? this.days - 1;
      const positions = { ArrowLeft: current - 1, ArrowDown: current - 1, ArrowRight: current + 1, ArrowUp: current + 1,
        Home: 0, End: this.days - 1, PageUp: current + 7, PageDown: current - 7 };
      if (Object.hasOwn(positions, event.key)) {
        event.preventDefault();
        this.highlight(Math.max(0, Math.min(this.days - 1, positions[event.key])));
      }
    });
    this.update();
  }

  disconnectedCallback() {
    clearInterval(this.timer);
  }

  scheduleRefresh() {
    clearInterval(this.timer);
    if (!this.ui('.auto input').checked) return;
    this.timer = setInterval(() => {
      if (!document.hidden && this.shadowRoot.activeElement !== this.ui('.plot')) this.advance();
    }, 25000);
  }

  advance() {
    this.end++;
    this.subscriberCounts = this.subscriberCounts.map((count, index) => count + youtubeDay(this.end, index).net);
    this.update('Sample refreshed through ' + dateLabel(this.end) + '.');
  }

  handleClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.source) {
      this.source = button.dataset.source;
      this.days = this.periods[this.source];
    }
    else if (button.dataset.days) this.periods[this.source] = this.days = Number(button.dataset.days);
    else if (button.dataset.metric) this.metrics[this.source] = button.dataset.metric;
    else if (button.classList.contains('refresh')) {
      this.advance();
      return;
    }
    this.update('Sample updated.');
  }

  update(notice = '') {
    const youtube = this.source === 'youtube';
    const metric = this.metrics[this.source];
    const read = day => youtube ? youtubeDay(day, Number(this.channel)) : appleDay(day, this.appleApp);
    this.rows = Array.from({ length: this.days }, (_, i) => read(this.end - this.days + 1 + i));
    const previous = Array.from({ length: this.days }, (_, i) => read(this.end - 2 * this.days + 1 + i));
    this.shadowRoot.querySelectorAll('[data-source]').forEach(el => el.setAttribute('aria-pressed', el.dataset.source === this.source));
    this.shadowRoot.querySelectorAll('[data-days]').forEach((el, i) => {
      const days = i === 0 ? 7 : youtube ? 28 : 30;
      el.dataset.days = String(days);
      el.textContent = days + 'd';
      el.setAttribute('aria-label', 'Last ' + days + ' days');
      el.setAttribute('aria-pressed', days === this.days);
    });
    const select = this.ui('select');
    if (select.dataset.source !== this.source) {
      const choices = youtube ? channels : apps;
      select.replaceChildren(...choices.map((choice, index) => new Option(choice.name, String(index))));
      if (!youtube) select.add(new Option('All apps', 'all'), 0);
      select.dataset.source = this.source;
    }
    select.value = youtube ? this.channel : this.appleApp;
    this.ui('.picker-caption').textContent = youtube ? 'YouTube channel' : 'App Store portfolio';
    let cards;
    if (youtube) {
      cards = [
        ['Views', amount.format(sum(this.rows, 'views')), this.change('views', previous)],
        ['Subscribers', amount.format(this.subscriberCounts[Number(this.channel)]), '+' + amount.format(sum(this.rows, 'net')) + ' this period'],
        ['Watch time', amount.format(sum(this.rows, 'hours')) + ' h', this.change('hours', previous)],
      ];
    } else {
      cards = [
        ['Paid downloads', amount.format(sum(this.rows, 'paid')), this.change('paid', previous)],
        ['In-app purchases', amount.format(sum(this.rows, 'iap')), this.change('iap', previous)],
        ['Est. proceeds', dollars.format(sum(this.rows, 'proceeds')), 'USD · after commission'],
      ];
    }
    this.ui('.cards').innerHTML = cards.map(([name, value, detail]) => `
        <div class="kpi"><span>${name}</span><strong>${value}</strong><small class="${detail.startsWith('−') ? 'negative' : detail.startsWith('USD') ? 'neutral' : ''}">${detail}</small></div>`).join('');
    const choices = youtube ? ['views', 'net'] : ['paid', 'proceeds'];
    this.ui('.metric-switch').querySelectorAll('button').forEach((el, i) => {
      const key = choices[i];
      el.dataset.metric = key;
      el.textContent = ({ net: 'Subscribers', paid: 'Downloads', proceeds: 'Proceeds' })[key] ?? metricNames[key];
      el.setAttribute('aria-label', 'Chart ' + metricNames[key].toLowerCase());
      el.setAttribute('aria-pressed', key === metric);
    });
    this.ui('.chart-title').textContent = ({ views: 'Daily views', net: 'Daily net subscribers', paid: 'Daily paid downloads', proceeds: 'Daily proceeds' })[metric];
    this.ui('.chart-dates').textContent = dateLabel(this.rows[0].day) + ' – ' + dateLabel(this.end);
    this.drawChart(metric);
    if (youtube) {
      const channel = channels[Number(this.channel)];
      this.ui('.activity-icon').innerHTML = icon('play');
      this.ui('.activity small').textContent = 'Latest upload';
      this.ui('.activity strong').textContent = channel.video;
      this.ui('.activity-value').textContent = abbreviated.format(Math.round(channel.base * 2.85 + (this.end - initialDay) * channel.base * 0.28)) + ' views';
    } else {
      const best = this.rows.reduce((a, b) => a.paid > b.paid ? a : b);
      this.ui('.activity-icon').innerHTML = icon('chart');
      this.ui('.activity small').textContent = 'Best sales day';
      this.ui('.activity strong').textContent = dateLabel(best.day) + ' · ' + select.selectedOptions[0].text;
      this.ui('.activity-value').textContent = amount.format(best.paid) + ' paid downloads';
    }
    if (notice) this.ui('[role="status"]').textContent = notice + ' ' + select.selectedOptions[0].text + ', ' + this.days + ' days. ' + cards[0][1] + ' ' + cards[0][0].toLowerCase() + '.';
  }

  change(metric, previous) {
    const baseline = sum(previous, metric);
    const change = baseline === 0 ? null : (sum(this.rows, metric) / baseline - 1) * 100;
    if (change === null) return 'No prior data';
    return (change < 0 ? '−' : '+') + Math.abs(change).toFixed(1) + '% vs. prior ' + this.days + 'd';
  }

  drawChart(metric) {
    const max = Math.max(...this.rows.map(row => row[metric]), 1);
    const step = 10 ** Math.floor(Math.log10(max)) / 2;
    this.ceiling = Math.ceil(max / step) * step;
    this.points = this.rows.map((row, i) => [600 * i / (this.rows.length - 1), 112 - row[metric] / this.ceiling * 108]);
    const path = this.points.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
    this.ui('.line').setAttribute('d', path);
    this.ui('.area').setAttribute('d', path + 'L600 112H0Z');
    this.ui('.ticks').querySelectorAll('span').forEach((el, i) => {
      el.textContent = formatMetric(metric, this.ceiling * (1 - i / 2), true);
    });
    const ticks = [0, Math.floor((this.days - 1) / 2), this.days - 1];
    this.ui('.x-axis').querySelectorAll('span').forEach((el, i) => { el.textContent = dateLabel(this.rows[ticks[i]].day); });
    this.ui('.plot').setAttribute('aria-label', this.ui('.chart-title').textContent + '. Use arrow keys to explore dates.');
    this.ui('.plot').setAttribute('aria-valuemax', String(this.days));
    this.highlight(null);
  }

  pointAt(event) {
    const bounds = this.ui('.plot').getBoundingClientRect();
    this.highlight(Math.max(0, Math.min(this.days - 1, Math.round((event.clientX - bounds.left) / bounds.width * (this.days - 1)))));
  }

  highlight(index) {
    this.selectedPoint = index;
    const selected = index ?? this.days - 1;
    const [x, y] = this.points[selected];
    const row = this.rows[selected];
    const metric = this.metrics[this.source];
    const text = dateLabel(row.day) + ' · ' + formatMetric(metric, row[metric]) + ' ' + (metric === 'proceeds' ? 'USD' : metricNames[metric].toLowerCase());
    const plot = this.ui('.plot');
    plot.style.setProperty('--point-x', (x / 6) + '%');
    plot.style.setProperty('--point-y', (y / 116 * 100) + '%');
    plot.toggleAttribute('data-active', index !== null);
    plot.setAttribute('aria-valuenow', String(selected + 1));
    plot.setAttribute('aria-valuetext', text);
    this.ui('.point-tip').textContent = text;
  }
}

if (!customElements.get('argus-demo')) customElements.define('argus-demo', ArgusDemo);
