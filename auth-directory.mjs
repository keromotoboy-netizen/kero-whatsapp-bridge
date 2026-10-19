import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertFreshPairingSafe } from './pairing-safety.mjs';

// Retain revoked credentials in their private original directory; never copy or erase them.
// CRM continues using DATA_DIR. Only Baileys follows this non-secret pointer.
export function selectAuthDirectory(dataDir, { freshPairing = false, loggedOut = false } = {}) {
  const pointer = path.join(dataDir, 'active-auth.json');
  let active = dataDir;
  if (fs.existsSync(pointer)) {
    const value = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    if (!/^session-[0-9a-f-]{36}$/.test(value.directory || '')) throw new Error('invalid_auth_pointer');
    active = path.join(dataDir, value.directory);
    if (!fs.existsSync(active) || fs.lstatSync(active).isSymbolicLink()) throw new Error('invalid_auth_pointer');
  }
  if (!freshPairing) return active;
  if (loggedOut) {
    const directory = 'session-' + randomUUID();
    const next = path.join(dataDir, directory);
    fs.mkdirSync(next, { mode: 0o700 });
    fs.writeFileSync(pointer + '.tmp', JSON.stringify({ directory }), { mode: 0o600 });
    fs.renameSync(pointer + '.tmp', pointer);
    return next;
  }
  const entries = fs.readdirSync(active);
  let pending = false;
  try { pending = JSON.parse(fs.readFileSync(path.join(active, 'creds.json'), 'utf8')).registered === false; } catch {}
  if (!pending) assertFreshPairingSafe(entries);
  return active;
}
