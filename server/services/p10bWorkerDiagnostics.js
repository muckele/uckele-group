import { sha256, stableCanonicalJson } from '../utils/security.js';
import { p10bGuestWindow } from './p10bGuestShutdown.js';

export const P10B_CREDENTIAL_NAMES = ['DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY',
  'DEAL_HUNTER_CIM_MAILBOX_RECONCILIATION_API_KEY', 'DEAL_HUNTER_CIM_MAILBOX_WEBHOOK_SECRET'];
const packetDigest = packet => { const { startedAt: _startedAt, ...canonical } = packet; return sha256(stableCanonicalJson(canonical)); };
const keys = ['app', 'machine', 'source', 'runtimeFlag', 'phase', 'storage', 'databasePath', 'window',
  'productionOff', 'providerOff', 'profile', 'provider', 'mode', 'sender', 'replyBase', 'domain',
  'recipient', 'outreachPaused', 'followUpOff', 'automationPaused', 'schedulerOff', 'dailyOff',
  'emailOff', 'aiOff', 'deliveryConsole'];

// Public predicates only: never read a credential property, including its
// truthiness, length or hash. Unknown names/values are never copied to output.
export function captureP10bWorkerDiagnostics({ config, packet, runtime, credentialKeyNames = [] }) {
  const p = config?.dealHunter?.cimProvider; let window = false;
  try { window = p?.qualificationGuestWindow === stableCanonicalJson(p10bGuestWindow(packet)); } catch { /* false */ }
  const predicates = {
    app: runtime?.app === packet.target.app, machine: runtime?.machineId === packet.target.machineId,
    source: runtime?.sourceHead === packet.sourceHead, runtimeFlag: p?.qualificationRuntime === true,
    phase: p?.qualificationPhase === packet.operation, storage: config?.storage?.provider === 'sqlite',
    databasePath: config?.storage?.sqlitePath === packet.databasePath, window,
    productionOff: config?.isProduction === false, providerOff: p?.enabled === false,
    profile: p?.profile === 'controlled-mailbox-v1', provider: p?.provider === 'resend', mode: p?.mode === 'controlled-mailbox',
    sender: p?.resendFromEmail === 'P10B Sender <sender@p10b-e2e.uckelegroup.com>',
    replyBase: p?.resendReplyTo === 'replies@p10b-e2e.uckelegroup.com', domain: p?.resendInboundDomain === 'p10b-e2e.uckelegroup.com',
    recipient: Array.isArray(p?.allowedRecipients) && p.allowedRecipients.length === 1 && p.allowedRecipients[0] === 'mathew@uckelegroup.com',
    outreachPaused: config?.dealHunter?.cimOutreach?.paused === true, followUpOff: config?.dealHunter?.cimFollowUp?.enabled === false,
    automationPaused: config?.dealHunter?.cimAutomation?.paused === true, schedulerOff: config?.dealHunter?.cimAutomation?.schedulerEnabled === false,
    dailyOff: config?.dealHunter?.dailyEmail?.enabled === false, emailOff: config?.followUp?.emailEnabled === false,
    aiOff: config?.followUp?.aiEnabled === false, deliveryConsole: config?.delivery?.provider === 'console',
  };
  return { version: 'p10b-worker-public-diagnostic-v1', packetDigest: packetDigest(packet),
    predicates, credentialNames: Object.fromEntries(P10B_CREDENTIAL_NAMES.map(key => [key, credentialKeyNames.includes(key)])) };
}

export function validateP10bWorkerDiagnostics(value, packet) {
  return Boolean(value && Object.keys(value).sort().join(',') === 'credentialNames,packetDigest,predicates,version'
    && value.version === 'p10b-worker-public-diagnostic-v1' && value.packetDigest === packetDigest(packet)
    && Object.keys(value.predicates || {}).sort().join(',') === [...keys].sort().join(',')
    && Object.values(value.predicates).every(v => typeof v === 'boolean')
    && Object.keys(value.credentialNames || {}).sort().join(',') === [...P10B_CREDENTIAL_NAMES].sort().join(',')
    && Object.values(value.credentialNames).every(v => typeof v === 'boolean'));
}
