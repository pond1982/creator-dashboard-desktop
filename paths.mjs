import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const support = path.join(homedir(), 'Library', 'Application Support', 'CreatorDashboard');
export const helper = path.join(support, 'keychain-helper');
export const port = 47831;
export const address = `http://127.0.0.1:${port}`;
