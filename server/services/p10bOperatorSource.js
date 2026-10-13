import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stableCanonicalJson } from '../utils/security.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from './p10bRuntimeOnlyOperator.js';
export const P10B_RETAINED_GUEST_HEAD = 'c4944a46ac362cdcd002e077d5533b4b0843b1d0';
export const P10B_RETAINED_IMAGE = 'sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc';
export const P10B_RETAINED_NATIVE_SHA256 = 'de28af1f823644d0eb4f4cd025b74791b2e041a660cd061cafc67c7175c0b088';
export function assertP10bReviewedCheckout(sourceHead) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceHead
    || execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('Exact clean reviewed source required');
}
export function assertP10bNoEmailHostBinding(session, checkSource = assertP10bReviewedCheckout) {
  if (session.sourceHead !== P10B_RETAINED_GUEST_HEAD || session.candidateImageDigest !== P10B_RETAINED_IMAGE
    || session.nativeClientSha256 !== P10B_RETAINED_NATIVE_SHA256
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
