import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [executable] = process.argv.slice(2);
if (!executable) throw new Error('Pass the path to the installed Creator Dashboard executable.');

const dir = await mkdtemp(path.join(os.tmpdir(), 'creator-installer-smoke-'));
const marker = path.join(dir, 'result.txt');
try {
  const child = spawn(path.resolve(executable), ['--smoke-test'], {
    stdio: 'inherit',
    env: { ...process.env, CREATOR_DASHBOARD_SMOKE_RESULT: marker }
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    const [code, signal] = await once(child, 'exit');
    if (code !== 0) throw new Error('Installed app smoke test failed (' + (signal || code) + ').');
    if ((await readFile(marker, 'utf8')).trim() !== 'ok') {
      throw new Error('Installed app exited without confirming its smoke checks.');
    }
    console.log('Installed app passed its desktop smoke checks.');
  } finally {
    clearTimeout(deadline);
  }
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
