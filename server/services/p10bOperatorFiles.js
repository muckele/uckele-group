import fs from 'node:fs';
import path from 'node:path';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { inspectP10bPriorArchive } from './p10bExistingArchiveRecovery.js';

const describe = s => {
  return { inode: String(s.ino), device: String(s.dev), mode: Number(s.mode), owner: Number(s.uid),
    mtime: String(s.mtimeNs), ctime: String(s.ctimeNs), nlink: Number(s.nlink), size: Number(s.size),
    regular: s.isFile(), symlink: s.isSymbolicLink() };
};
const stat = file => describe(fs.lstatSync(file, { bigint: true }));
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function anchorDirectory(file) {
  if (fs.realpathSync(file) !== file) throw Error('Canonical directory without symlink ancestors required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const s = describe(fs.fstatSync(fd, { bigint: true }));
    if (stableCanonicalJson(s) !== stableCanonicalJson(stat(file)) || fs.realpathSync(file) !== file) throw Error('Directory changed during admission');
    return { ownerControlled: s.owner === process.getuid() && (s.mode & 0o777) === 0o700, symlink: false,
      inode: s.inode, device: s.device, owner: s.owner, mode: s.mode };
  } finally { fs.closeSync(fd); }
}
function snapshot(file) {
  const directory = anchorDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = describe(fs.fstatSync(fd, { bigint: true }));
    if (!before.regular || before.size > 65536 || before.owner !== process.getuid() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1) throw Error('Private bounded public evidence required');
    const buffer = Buffer.alloc(before.size + 1); let count = 0;
    while (count < buffer.length) { const n = fs.readSync(fd, buffer, count, buffer.length - count, null); if (!n) break; count += n; }
    const bytes = buffer.subarray(0, count).toString('utf8');
    if (Buffer.byteLength(bytes) !== before.size || stableCanonicalJson(before) !== stableCanonicalJson(describe(fs.fstatSync(fd, { bigint: true })))
      || stableCanonicalJson(before) !== stableCanonicalJson(stat(file))) throw Error('Public evidence changed during snapshot');
    if (stableCanonicalJson(anchorDirectory(path.dirname(file))) !== stableCanonicalJson(directory)) throw Error('Public parent directory changed');
    return { bytes, stat: before };
  } finally { fs.closeSync(fd); }
}
const sync = file => { const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
const read = file => {
  if (!stat(file).regular || stat(file).symlink) throw Error('Plain retained evidence required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const s = fs.fstatSync(fd); if (!s.isFile() || s.size > 1048576) throw Error('Evidence bound'); return fs.readFileSync(fd, 'utf8'); }
  finally { fs.closeSync(fd); }
};
export function createP10bRecoveryFilesystem() {
  return { stat, read, snapshot, anchorDirectory, exists,
    statDirectory(file) { const s = fs.lstatSync(file); return { symlink: s.isSymbolicLink(),
      ownerControlled: s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o022) === 0 }; },
    writeExclusive(file, value) { fs.writeFileSync(file, `${stableCanonicalJson(value)}\n`, { flag: 'wx', mode: 0o600 }); },
    syncFile: sync, syncDirectoryOf: file => sync(path.dirname(file)),
    linkExclusive: (from, to) => fs.linkSync(from, to), unlinkActive: file => fs.unlinkSync(file) };
}
export function inspectP10bRecovery(session, filesystem = createP10bRecoveryFilesystem()) {
  if (session.recovery && 'priorArchive' in session.recovery) return inspectP10bPriorArchive(session.recovery, filesystem);
  const e = session.recovery; const archive = filesystem.stat(e.archivePath);
  if (!archive.regular || archive.symlink) throw Error('Plain recovery archive required');
  return { activeAbsent: !filesystem.exists(e.activePath), archiveSha256: sha256(filesystem.read(e.archivePath)),
    ...(filesystem.exists(e.activePath) ? { activeRecord: JSON.parse(filesystem.read(e.activePath)) } : {}),
    archiveDevice: archive.device, archiveInode: archive.inode, attemptSha256: sha256(filesystem.read(e.attemptPath)) };
}
export function createP10bOperatorEvidence(directory) {
  const root = path.resolve(directory); const s = fs.lstatSync(root);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o022)) throw Error('Private existing evidence directory required');
  const target = name => { if (!/^[A-Za-z0-9_.-]{1,160}$/.test(name)) throw Error('Evidence name denied'); return path.join(root, name); };
  return { root, has: name => fs.existsSync(target(name)), read: name => JSON.parse(read(target(name))),
    write(name, value) { const file = target(name); fs.writeFileSync(file, `${stableCanonicalJson(value)}\n`, { flag: 'wx', mode: 0o600 }); sync(file); sync(root); } };
}
export function readP10bPublicJson(file) { return JSON.parse(read(path.resolve(file))); }
