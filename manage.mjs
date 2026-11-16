import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { address, root, support, helper } from './paths.mjs';

const label = 'local.creator-dashboard';
const domain = 'gui/' + process.getuid?.();
const agents = path.join(homedir(), 'Library', 'LaunchAgents');
const plist = path.join(agents, label + '.plist');
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const launchctl = (...args) => execFileSync('/bin/launchctl', args, { stdio: 'pipe' });
function loaded() {
  try { launchctl('print', domain + '/' + label); return true; } catch { return false; }
}

async function buildHelper() {
  const source = path.join(root, 'native', 'keychain.m');
  const built = await stat(helper).catch(() => null);
  if (built && built.mtimeMs >= (await stat(source)).mtimeMs) return;
  try { execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' }); }
  catch { throw new Error('Install the Apple Command Line Tools with xcode-select --install, then start the dashboard again.'); }
  const temp = helper + '.' + process.pid;
  execFileSync('/usr/bin/clang', ['-fobjc-arc', '-O2', source, '-framework', 'Foundation', '-framework', 'Security', '-o', temp]);
  await rename(temp, helper);
}

async function start() {
  await mkdir(support, { recursive: true, mode: 0o700 });
  await buildHelper();
  await mkdir(agents, { recursive: true, mode: 0o700 });
  // Prefer a stable launcher only when it resolves to the Node version used for setup.
  let node = process.execPath;
  const running = await realpath(node);
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (await realpath(candidate).catch(() => null) === running) {
      node = candidate;
      break;
    }
  }
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(root, 'server.mjs'))}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardErrorPath</key><string>${xml(path.join(support, 'service.log'))}</string>
</dict></plist>
`;
  const old = await readFile(plist, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (old !== content) {
    await writeFile(plist + '.tmp', content, { mode: 0o600 });
    await rename(plist + '.tmp', plist);
    if (loaded()) launchctl('bootout', domain + '/' + label);
  }
  if (!loaded()) launchctl('bootstrap', domain, plist);
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(address + '/api/health', { signal: AbortSignal.timeout(700), redirect: 'error' })
      .then(r => r.json()).catch(() => null);
    if (response?.service === 'creator-dashboard') {
      console.log('Open ' + address);
      return;
    }
    await delay(200);
  }
  throw new Error('The dashboard did not start. See ' + path.join(support, 'service.log'));
}

async function stop() {
  if (loaded()) launchctl('bootout', domain + '/' + label);
  // Remove only the generated per-user launch entry so macOS will not restart it at login.
  const { unlink } = await import('node:fs/promises');
  await unlink(plist).catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log('The legacy browser dashboard is stopped. Start Dashboard.command will start it again.');
}

try {
  process.umask(0o077);
  if (process.platform !== 'darwin') throw new Error('The legacy browser service requires macOS for its Keychain helper and background updates.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer, then start the dashboard again.');
  if (process.argv[2] === 'start') await start();
  else if (process.argv[2] === 'stop') await stop();
  else throw new Error('Run node manage.mjs start or node manage.mjs stop.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
