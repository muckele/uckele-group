import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from './p10bRuntimeOnlyOperator.js';
export const P10B_RETAINED_GUEST_HEAD = 'c4944a46ac362cdcd002e077d5533b4b0843b1d0';
export const P10B_RETAINED_IMAGE = 'sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc';
// Shared default executable supports both separately admitted session versions
// and the distinct read-only log mode. Permission/mutation limits remain typed.
export const P10B_GUARDIAN_NATIVE_SHA256 = 'f0f100c036ac133232e26f771cd609a4bd188eacc0e700c2fee55a4ef7cf3d09';
export const P10B_RETAINED_NATIVE_SHA256 = 'f0f100c036ac133232e26f771cd609a4bd188eacc0e700c2fee55a4ef7cf3d09';
export function assertP10bFlyExecutable(session, executable = session?.flyExecutable?.path) {
  const binding = session?.flyExecutable;
  if (!binding || executable !== binding.path || typeof executable !== 'string' || path.resolve(executable) !== executable
    || !/^[a-f0-9]{64}$/.test(binding.sha256 || '')) throw Error('Session-bound Fly executable required');
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024
    || sha256(fs.readFileSync(executable)) !== binding.sha256) throw Error('Session-bound Fly executable changed');
  fs.accessSync(executable, fs.constants.X_OK);
  return executable;
}
export function assertP10bReviewedCheckout(sourceHead) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const prefix = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root];
  const options = { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } };
  if (execFileSync('/usr/bin/git', [...prefix, 'rev-parse', 'HEAD'], options).trim() !== sourceHead
    || execFileSync('/usr/bin/git', [...prefix, 'status', '--porcelain'], options).trim()) throw Error('Exact clean reviewed source required');
}
export function assertP10bNoEmailHostBinding(session, checkSource = assertP10bReviewedCheckout) {
  if (session.sourceHead !== P10B_RETAINED_GUEST_HEAD || session.candidateImageDigest !== P10B_RETAINED_IMAGE
    || session.nativeClientSha256 !== (session.version === 'p10b-guardian-only-session-v1' ? P10B_GUARDIAN_NATIVE_SHA256 : P10B_RETAINED_NATIVE_SHA256)
    || !/^[a-f0-9]{40}$/.test(session.hostSourceHead || '') || session.hostSourceHead === session.sourceHead) {
    throw Error('Exact retained guest/image/native and separate host revision required');
  }
  checkSource(session.hostSourceHead);
}
export function assertP10bPreparationHostSource({ session, approval, phase, packet, now = Date.now(), checkSource }) {
  assertP10bNoEmailApproval(session, approval, now);
  assertP10bFrozenPhase(session, phase);
  if (phase.label !== 'prepare' || packet.operation !== 'prepare'
    || stableCanonicalJson(packet) !== stableCanonicalJson(phase.packet)) throw Error('Exact no-email preparation packet required');
  assertP10bNoEmailHostBinding(session, checkSource);
}
