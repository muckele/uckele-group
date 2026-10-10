import fs from 'node:fs';
import path from 'node:path';
import { sha256, stableCanonicalJson } from '../utils/security.js';

const stat = file => {
  const s = fs.lstatSync(file, { bigint: true });
  return { inode: String(s.ino), device: String(s.dev), mode: Number(s.mode), owner: Number(s.uid),
    mtime: String(s.mtimeNs), regular: s.isFile(), symlink: s.isSymbolicLink() };
};
const sync = file => { const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
const read = file => {
  if (!stat(file).regular || stat(file).symlink) throw Error('Plain retained evidence required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const s = fs.fstatSync(fd); if (!s.isFile() || s.size > 1048576) throw Error('Evidence bound'); return fs.readFileSync(fd, 'utf8'); }
  finally { fs.closeSync(fd); }
};
export function createP10bRecoveryFilesystem() {
  return { stat, read, exists: file => fs.existsSync(file),
    statDirectory(file) { const s = fs.lstatSync(file); return { symlink: s.isSymbolicLink(),
      ownerControlled: s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o022) === 0 }; },
    writeExclusive(file, value) { fs.writeFileSync(file, `${stableCanonicalJson(value)}\n`, { flag: 'wx', mode: 0o600 }); },
    syncFile: sync, syncDirectoryOf: file => sync(path.dirname(file)),
    linkExclusive: (from, to) => fs.linkSync(from, to), unlinkActive: file => fs.unlinkSync(file) };
}
export function inspectP10bRecovery(session, filesystem = createP10bRecoveryFilesystem()) {
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
