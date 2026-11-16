import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDashboard } from './dashboard.mjs';
import { root, port, address, support } from './paths.mjs';
import { openSettings } from './settings.mjs';
import { createAnalytics } from './analytics.mjs';
import { reportDocument, renderPdf } from './reports.mjs';
import { validateApplePeriod } from './apple.mjs';

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2' };
const publicDir = path.join(root, 'public');

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 16384) throw new Error('The submitted setup is too large.');
    chunks.push(part);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw new Error('The request must contain a JSON object.');
}

export async function makeServer(dashboard, localPort = port, analytics = null, settings = null, options = {}) {
  settings ??= await openSettings(support, dashboard.state());
  const assets = new Set(await readdir(publicDir));
  const hosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
  const token = options.sessionToken ? Buffer.from(options.sessionToken) : null;
  const printReport = options.renderPdf ?? renderPdf;
  const launchUrl = options.openExternal ?? (url => promisify(execFile)('/usr/bin/open', [url]));
  const channelIds = () => (dashboard.state().youtube.data || []).map(channel => channel.id);
  const state = () => ({ ...dashboard.state(), analytics: analytics?.state(channelIds()), settings: settings.get() });
  const periodSnapshots = new Map();
  const appleIdentity = () => {
    const { issuerId, vendorNumber, keyId, updatedAt } = dashboard.state().apple;
    return JSON.stringify([issuerId, vendorNumber, keyId, updatedAt]);
  };
  let rendering = false;
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://i.ytimg.com https://yt3.ggpht.com https://yt3.googleusercontent.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const host = req.headers.host;
    const expectedOrigin = options.getOrigin?.();
    if (expectedOrigin ? host !== new URL(expectedOrigin).host : !hosts.has(host)) {
      return json(403, { error: 'Open Argus Pip on this computer.' });
    }
    const route = req.url.split('?')[0];
    try {
      const query = new URL(req.url, expectedOrigin || address).searchParams;
      const isConsent = req.method === 'GET' && analytics && query.has('state') &&
        (query.has('code') || query.has('error')) && (route === '/' || route === '/oauth/google/callback');
      if (token && !isConsent) {
        const received = Buffer.from(req.headers['x-creator-session'] || '');
        if (received.length !== token.length || !timingSafeEqual(received, token)) {
          return json(403, { error: 'Open Argus Pip to access this page.' });
        }
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (isConsent) {
          let channel, failure;
          try {
            channel = await analytics.callback(query, channelIds);
          } catch (error) {
            failure = error.message;
          }
          if (token) {
            res.writeHead(failure ? 400 : 200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(failure ? 'Sign-in did not finish. ' + failure : 'Channel connected. You can close this tab and return to Argus Pip.');
          }
          // Replace the callback URL so authorization codes never enter the app or outgoing links.
          const target = failure ? '/#analytics-error/' + encodeURIComponent(failure) : '/#youtube/' + encodeURIComponent(channel);
          res.writeHead(303, { Location: target });
          return res.end();
        }
        if (route === '/api/state') return json(200, state());
        if (route === '/api/health') return json(200, { service: 'creator-dashboard' });
        const name = route === '/' ? 'index.html' : route.slice(1);
        const type = types[path.extname(name)];
        if (!type || !assets.has(name)) return json(404, { error: 'Page not found.' });
        const file = await readFile(path.join(publicDir, name));
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': file.length });
        return res.end(file);
      }
      if (req.method !== 'POST') return json(405, { error: 'Method not supported.' });
      if (req.headers['x-dashboard-request'] !== '1' || req.headers['content-type']?.split(';')[0] !== 'application/json' ||
          (req.headers.origin && req.headers.origin !== 'http://' + host) ||
          req.headers['sec-fetch-site'] === 'cross-site') {
        return json(403, { error: 'Submit this request from the local dashboard.' });
      }
      const body = await readBody(req);
      if (route === '/api/settings') {
        return json(200, { ok: true, settings: await settings.save(body) });
      } else if (route === '/api/setup/youtube' || route === '/api/setup/apple') {
        await dashboard.sync(route.split('/').pop(), body);
      } else if (route === '/api/refresh') {
        await dashboard.sync(body.source);
      } else if (route === '/api/apple/period') {
        const identity = appleIdentity();
        const report = await dashboard.applePeriod(body.days);
        if (identity !== appleIdentity()) throw new Error('The Apple connection or snapshot changed. Select the period again.');
        periodSnapshots.set(body.days, { identity, report });
        return json(200, { report });
      } else if (route === '/api/report') {
        if (rendering) return json(409, { error: 'A PDF is being generated. Try again when it finishes.' });
        const snapshot = state();
        if (body.updatedAt && snapshot[body.source]?.updatedAt !== body.updatedAt) {
          return json(409, { error: 'The source has refreshed. Reload the page to export the latest snapshot.' });
        }
        let period;
        rendering = true;
        try {
          if (body.source === 'apple') {
            validateApplePeriod(body.days);
            if (!snapshot.apple.configured) throw new Error('Connect App Store Connect first.');
            if (body.days === 7) period = snapshot.apple.data;
            else {
              const saved = periodSnapshots.get(body.days);
              const identity = appleIdentity();
              period = saved?.identity === identity ? saved.report : await dashboard.applePeriod(body.days);
              if (identity !== appleIdentity()) throw new Error('The Apple connection changed. Reload the sales page.');
            }
          }
          const { html, filename } = reportDocument(snapshot, body, period);
          const bytes = await printReport(html);
          res.writeHead(200, {
            'Content-Type': 'application/pdf', 'Content-Length': bytes.length,
            'Content-Disposition': 'attachment; filename="creator-report.pdf"; filename*=UTF-8\'\'' + encodeURIComponent(filename)
          });
          return res.end(bytes);
        } finally { rendering = false; }
      } else if (route === '/api/analytics/client' && analytics) {
        await analytics.setClient(body);
      } else if ((route === '/api/analytics/connect' || route === '/api/analytics/refresh') && analytics) {
        if (!channelIds().includes(body.channelId)) throw new Error('Select a connected YouTube channel.');
        if (route.endsWith('/connect')) {
          const url = await analytics.begin(body.channelId);
          const opened = await launchUrl(url).then(() => true, () => false);
          return json(200, { url, opened });
        }
        await analytics.refresh(body.channelId);
      } else {
        return json(404, { error: 'Unknown action.' });
      }
      return json(200, { ok: true });
    } catch (error) {
      return json(400, { error: error.message || 'The request could not be completed.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const dashboard = await createDashboard();
  const analytics = await createAnalytics();
  const settings = await openSettings(support, dashboard.state());
  const server = await makeServer(dashboard, port, analytics, settings);
  server.listen(port, '127.0.0.1', () => {
    console.log('Argus Pip is available at ' + address);
    const tick = async () => {
      await dashboard.tick(settings.get().sources).catch(() => console.error('Could not update the local cache.'));
      const ids = settings.get().sources.includes('youtube') ? (dashboard.state().youtube.data || []).map(channel => channel.id) : [];
      await analytics.tick(ids).catch(() => console.error('Could not update private channel analytics.'));
    };
    tick();
    setInterval(tick, 60000).unref();
  });
}
