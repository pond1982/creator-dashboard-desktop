import { spawn } from 'node:child_process';
import { helper } from './paths.mjs';

export function keychain(operation, account, value) {
  return new Promise((resolve, reject) => {
    const proc = spawn(helper, [operation, account], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 60000 });
    const chunks = [];
    proc.stdout.on('data', chunk => chunks.push(chunk));
    proc.on('error', () => reject(new Error('The Keychain helper is unavailable. Open Start Dashboard.command to repair it.')));
    proc.stdin.on('error', () => {}); // The exit code reports helper failures.
    proc.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else if (code === 44) reject(new Error('The saved key is missing. Reconnect this source in the dashboard.'));
      else reject(new Error('macOS Keychain could not complete the request. Unlock your login keychain and try again.'));
    });
    proc.stdin.end(value);
  });
}
