import { element, link, count, day, control, metric, photo, tableFrame } from './ui.js';

const watch = video => 'https://www.youtube.com/watch?v=' + encodeURIComponent(video.id);
const duration = seconds => {
  if (!Number.isFinite(seconds)) return '—';
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return parts.slice(parts[0] ? 0 : 1).map((n, i) => i ? String(n).padStart(2, '0') : n).join(':');
};
const median = values => {
  if (!values.length) return null;
  const ordered = values.toSorted((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
};

function avatar(channel, size = '') {
  const frame = element('span', 'avatar ' + size, Array.from(channel.title)[0] || '•');
  frame.setAttribute('aria-hidden', 'true');
  const img = photo(channel.thumbnail, '');
  if (img) frame.append(img);
  return frame;
}

export function channelTabs(channels, selectedId) {
  const nav = element('nav', 'channel-tabs');
  nav.setAttribute('aria-label', 'YouTube channels');
  for (const channel of channels) {
    const tab = link('', '#youtube/' + encodeURIComponent(channel.id));
    if (channel.id === selectedId) tab.setAttribute('aria-current', 'page');
    tab.append(avatar(channel), element('span', '', channel.title));
    nav.append(tab);
  }
  return nav;
}

function latestVideo(video) {
  const box = element('section', 'panel latest');
  const head = element('div', 'panel-title');
  head.append(element('h2', '', 'Latest release'));
  box.append(head);
  if (!video) {
    box.append(element('p', 'data-empty', 'No public release available.'));
    return box;
  }
  const media = link('', watch(video), 'feature-image', true);
  media.setAttribute('aria-label', 'Watch ' + video.title);
  const img = photo(video.thumbnail, '');
  if (img) media.append(img);
  media.append(element('span', 'play', '▶'));
  if (video.liveStatus === 'live' || Number.isFinite(video.durationSeconds))
    media.append(element('span', 'timecode', video.liveStatus === 'live' ? 'Live' : duration(video.durationSeconds)));
  const detail = element('div', 'feature-detail');
  detail.append(element('p', 'eyebrow', day(video.publishedAt)), link(video.title, watch(video), 'feature-title', true));
  const values = element('dl', 'feature-metrics');
  for (const [key, label] of [['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comments']]) values.append(metric(label, count(video[key])));
  detail.append(values);
  box.append(media, detail);
  return box;
}

function performance(videos) {
  const box = element('section', 'panel performance');
  const head = element('div', 'panel-title');
  head.append(element('h2', '', 'Views by upload'));
  box.append(head);
  if (!videos.length) {
    box.append(element('p', 'data-empty', 'No recent public uploads available.'));
    return box;
  }
  const ordered = [...videos].reverse();
  const views = ordered.filter(v => Number.isFinite(v.views)).map(v => v.views);
  const sample = ordered.length + (ordered.length === 1 ? ' recent upload' : ' recent uploads');
  box.append(element('p', 'chart-caption', sample + ' · Cumulative views per video'));
  if (views.length) {
    const high = Math.max(...views);
    const graph = element('figure', 'chart');
    const area = element('div', 'plot');
    area.setAttribute('aria-hidden', 'true');
    const scale = element('div', 'scale');
    scale.append(element('span', '', count(high)), element('span', '', '0'));
    const bars = element('div', 'bars');
    for (const video of ordered) {
      const bar = element('span', 'chart-bar');
      if (Number.isFinite(video.views) && video.views > 0) {
        bar.style.height = (100 * video.views / high) + '%';
        if (video.views === high) bar.classList.add('peak');
      } else bar.classList.add('zero');
      bar.title = video.title + ' · ' + count(video.views) + ' views';
      bars.append(bar);
    }
    area.append(scale, bars);
    const axis = element('figcaption', 'axis');
    axis.append(element('span', '', day(ordered[0].publishedAt, true)), element('span', '', day(ordered.at(-1).publishedAt, true)));
    graph.append(area, axis);
    box.append(graph);
  }
  const dates = ordered.map(v => new Date(v.publishedAt).getTime()).filter(Number.isFinite);
  const gaps = dates.slice(1).map((date, i) => (date - dates[i]) / 86400000);
  const typicalGap = median(gaps);
  const gap = typicalGap === null ? '—' : typicalGap < 1 ? Math.round(typicalGap * 24) + ' h' : Number(typicalGap.toFixed(1)) + ' d';
  const readings = element('dl', 'chart-metrics');
  readings.append(metric('Median views', count(median(views))), metric('Median upload gap', gap));
  box.append(readings);
  return box;
}

function videoTable(videos, sort, onSort) {
  const box = element('section', 'panel uploads');
  const head = element('div', 'panel-title');
  head.append(element('h2', '', 'Recent uploads'), control('Sort by', [
    ['newest', 'Newest first'], ['views', 'Most views'], ['likes', 'Most likes'], ['comments', 'Most comments']
  ], sort, onSort));
  box.append(head);
  if (!videos.length) {
    box.append(element('p', 'data-empty', 'No public uploads available.'));
    return box;
  }
  const ranked = sort === 'newest' ? videos : videos.toSorted((a,b) => (b[sort] ?? -1) - (a[sort] ?? -1));
  const { scroll, body } = tableFrame('Recent public videos with cumulative statistics', ['Video', 'Published', 'Duration', 'Views', 'Likes', 'Comments']);
  for (const v of ranked) {
    const row = element('tr');
    const name = element('th');
    name.scope = 'row';
    const title = link('', watch(v), 'table-title', true);
    const img = photo(v.thumbnail, 'video-thumb');
    if (img) title.append(img);
    const detail = element('span', '', v.title);
    if (v.liveStatus === 'live' || v.liveStatus === 'completed') detail.append(element('small', 'video-type', v.liveStatus === 'live' ? 'Live now' : 'Livestream replay'));
    title.append(detail);
    name.append(title);
    if (v.description || typeof v.captions === 'boolean' || v.liveStatus) {
      const detail = element('details', 'video-details');
      detail.append(element('summary', '', 'Video details'));
      if (v.description) detail.append(element('p', '', v.description));
      const format = { live: 'Live now', completed: 'Livestream replay', none: 'Recorded upload' }[v.liveStatus];
      const captions = typeof v.captions === 'boolean' ? (v.captions ? 'Captions available' : 'No captions listed') : '';
      const facts = [format, captions].filter(Boolean).join(' · ');
      if (facts) detail.append(element('p', 'muted', facts));
      name.append(detail);
    }
    row.append(name, element('td', '', day(v.publishedAt)), element('td', '', duration(v.durationSeconds)), element('td', 'amount', count(v.views)), element('td', '', count(v.likes)), element('td', '', count(v.comments)));
    body.append(row);
  }
  box.append(scroll);
  return box;
}

export function renderChannel(box, channel, actions, sort, onSort, studioPanel) {
  const videos = channel.videos ?? (channel.video ? [channel.video] : []);
  const hero = element('header', 'report-head');
  const identity = element('div', 'identity');
  const desc = element('div');
  desc.append(element('h1', '', channel.title));
  const meta = [channel.handle, channel.joinedAt && 'Joined ' + day(channel.joinedAt), channel.country].filter(Boolean);
  const channelLink = link(meta.join(' · ') || 'View channel on YouTube ↗', 'https://www.youtube.com/channel/' + encodeURIComponent(channel.id), 'profile-link', true);
  desc.append(channelLink);
  identity.append(avatar(channel, 'large'), desc);
  hero.append(identity, actions);
  box.append(hero);
  const facts = element('dl', 'stat-band');
  facts.append(metric('Subscribers', count(channel.subscribers), 'Rounded by YouTube'), metric('Lifetime views', count(channel.lifetimeViews)), metric('Public videos', count(channel.publicVideoCount)));
  const details = element('div', 'feature-grid');
  details.append(latestVideo(videos[0]), performance(videos));
  box.append(facts, details, studioPanel, videoTable(videos, sort, onSort));
  if (channel.description) {
    const about = element('details', 'about');
    about.append(element('summary', '', 'About this channel'), element('p', '', channel.description));
    box.append(about);
  }
}
