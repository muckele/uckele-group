import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function assertP10bReviewedCheckout(sourceHead) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceHead
    || execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('Exact clean reviewed source required');
}
