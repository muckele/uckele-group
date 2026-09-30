import Database from 'better-sqlite3';
import { authorizePreparedCimTransmission } from '../../server/services/pursueCimFinalGate.js';
import { createSqliteStorage } from '../../server/storage/sqlite.js';

process.on('message', async ({ sqlitePath, mode, command }) => {
  if (mode === 'owner-command' || mode === 'pre-provider-transition'
    || mode === 'final-gate-service'
    || mode === 'campaign-allocation') {
    const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
    try {
      if (mode === 'owner-command') {
        const result = await storage.recordOwnerDecision(command);
        process.send?.({ ok: true, result: { applied: result.applied, replay: result.replay,
          conflict: result.conflict, decisionId: result.decision?.id ?? null } });
      } else if (mode === 'campaign-allocation') {
        const result = await storage.materializePursuitCampaign(command);
        process.send?.({ ok: true, result: { applied: result.applied,
          existing: result.existing, actionRequired: result.actionRequired } });
      } else if (mode === 'final-gate-service') {
        const result = await authorizePreparedCimTransmission({
          storage,
          ...command.args,
          loadMemberAuthority: async () => command.memberAuthority,
          readCurrentAuthority: async () => command.currentAuthority,
          readProviderReadiness: async () => command.providerReadiness,
        });
        process.send?.({ ok: true, result: {
          authorized: result.authorized,
          blockedReason: result.blockedReason,
          reconciliationOnly: result.reconciliationOnly,
          hasBoundaryNonce: Object.hasOwn(result, 'boundaryNonce'),
        } });
      } else {
        const { method, payload } = command;
        if (!['claimDueCimTouch', 'prepareCimTransmission',
          'issueCimLiveProviderAuthorization', 'authorizeCimProviderPending'].includes(method)) {
          throw new Error('Unsupported pre-provider test transition');
        }
        const result = await storage[method](payload);
        process.send?.({ ok: true, result: { claimed: result.claimed ?? false,
          alreadyOwned: result.alreadyOwned ?? false,
          staleAuthority: result.staleAuthority ?? false,
          conflict: result.conflict ?? false,
          terminal: result.terminal ?? false,
          existing: result.existing ?? false,
          payloadConflict: result.payloadConflict ?? false,
          prepared: result.prepared ?? false, issued: result.issued ?? false,
          authorized: result.authorized ?? false } });
      }
    } catch (error) {
      process.send?.({ ok: false, error: error.message });
    } finally {
      storage.close();
    }
    return;
  }
  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'deal_hunter_%'
      ORDER BY name
    `).all().map(({ name }) => name);
    process.send?.({ ok: true, tables });
  } catch (error) {
    process.send?.({ ok: false, error: error.message });
  } finally {
    database.close();
  }
});
