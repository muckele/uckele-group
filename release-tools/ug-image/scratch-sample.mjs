// Fixed fixture accounting only; no application imports or data contents read.
import fs from 'node:fs';
const MiB = 1024 * 1024;
if (fs.readdirSync('/dev/mqueue').length !== 0) throw new Error('unexpected fixture message queue');
function bytes(root, allowDevices = false) {
  let logical = 0; let allocated = 0; let entries = 0;
  const walk = (path) => {
    let s;
    try { s = fs.lstatSync(path); } catch (error) {
      if (error.code === 'ENOENT' && /^\/tmp\/ug-smoke\/fixture\.sqlite-(wal|shm|journal)$/.test(path)) {
        throw Object.assign(new Error('known SQLite coordination transition'), { retryKnownCoordination: true });
      }
      throw error;
    }
    if (++entries > 1000) throw new Error('fixture entry limit');
    if (s.isSymbolicLink() && allowDevices) return;
    if (!s.isDirectory() && !s.isFile()) {
      if (allowDevices && (s.isCharacterDevice() || s.isFIFO() || s.isSocket())) return;
      throw new Error('unexpected writable fixture object');
    }
    logical += s.size; allocated += s.blocks * 512;
    if (s.isDirectory()) for (const n of fs.readdirSync(path)) {
      const child = `${path}/${n}`;
      if (allowDevices && ['/dev/shm', '/dev/pts', '/dev/mqueue'].includes(child)) continue;
      walk(child);
    }
  };
  walk(root);
  const v = fs.statfsSync(root);
  return Math.max(logical, allocated, (v.blocks - v.bfree) * v.bsize);
}
function boundedCoordinationSample(root) {
  try { return bytes(root); } catch (error) {
    if (!error.retryKnownCoordination) throw error;
    return bytes(root); // Exactly one full rescan, never arbitrary ENOENT ignore.
  }
}
const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n');
for (const line of mounts) {
  const [before, after] = line.split(' - '); const fields = before.split(' ');
  const destination = fields[4]; const writable = fields[5].split(',').includes('rw');
  const type = after.split(' ')[0];
  if (!writable || ['proc', 'devpts', 'mqueue'].includes(type)) continue;
  if (!['/tmp', '/dev', '/dev/shm', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf'].includes(destination)) {
    throw new Error('unexpected writable mount destination');
  }
}
const result = { tmp_bytes: boundedCoordinationSample('/tmp'),
  shm_bytes: bytes('/dev/shm'), dev_bytes: bytes('/dev', true) };
if (result.tmp_bytes > 240 * MiB || result.shm_bytes > MiB || result.dev_bytes > 13 * MiB) {
  throw new Error('fixture component cap');
}
console.log(JSON.stringify(result));
