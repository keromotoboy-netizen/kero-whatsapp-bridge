import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export function readSnapshot(file) {
  if (fs.existsSync(file + '.gz')) return JSON.parse(gunzipSync(fs.readFileSync(file + '.gz')).toString('utf8'));
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
export function writeSnapshot(file, state, io = fs) {
  const bytes = gzipSync(JSON.stringify(state), { level: 3 });
  const temporary = file + '.tmp';
  if (io.existsSync(temporary) && io.lstatSync(temporary).isSymbolicLink()) throw new Error('unsafe_snapshot_temporary');
  // Reuse only the derived staging file. Keep the legacy JSON and prior gzip intact
  // until a complete, fsynced, hash-verified replacement can be renamed atomically.
  const fd = io.openSync(temporary, 'w', 0o600);
  try { io.writeFileSync(fd, bytes); io.fsyncSync(fd); } finally { io.closeSync(fd); }
  const digest = data => createHash('sha256').update(data).digest('hex');
  if (digest(io.readFileSync(temporary)) !== digest(bytes)) throw new Error('snapshot_write_verification_failed');
  io.renameSync(temporary, file + '.gz');
  return { compressedBytes: bytes.length };
}
export function snapshotStorageMetrics(file) {
  const size = p => fs.existsSync(p) ? fs.statSync(p).size : 0;
  const volume = fs.statfsSync(path.dirname(file));
  return { legacyBytes: size(file), compressedBytes: size(file + '.gz'), temporaryBytes: size(file + '.tmp'), availableBytes: volume.bavail * volume.bsize, capacityBytes: volume.blocks * volume.bsize };
}
