# Prepared zero-provider shutdown timing demonstration — not executed

**Status:** protocol prepared for a separate future owner approval. Current authority covers code and offline tests only. No command below has been run against Fly. No image has been built/pushed, no Machine updated/started and no real credential read. App `uckele-group-p10b`, Machine `0803730bd1d7e8`, volume `vol_vwnkpex1k3yx9dnv` remain outside execution authority and must remain stopped.

## Smallest future approval

Approve only the exact reviewed source/image build and stopped-Machine configuration update plus a zero-provider shutdown timing window on the existing isolated Machine. Approval must freeze source SHA, immutable image digest, configuration diff, fresh absent `/data/p10b-first-mailbox-<reviewed-demo-id>.sqlite` path, public window/run digest, absolute issuedAt/stopAt, cost evidence and observer placement. No new Machine, volume, service, credential or paid observer is required. No live business records are read/deleted. Keep `productionReady=false`, restart `no`, autostart false, autostop off, all automation/sending hard-offs and global pause.

This approval does **not** grant a preparation run, qualification packet, provider request or email. Those remain separate owner decisions. The configured process exit-to-stopped timing is an empirical platform prerequisite, not established by offline tests or a documented Fly timing guarantee.

## Demo process configuration

For this **demo only**, replace the application process with an inert Node keepalive, and keep the shipped independent guard. Both processes must ignore app secrets. The inert process opens no listener/database and imports no application/provider code:

```json
{
  "processes": [
    {"exec":["node","-e","setInterval(() => {}, 2147483647)"],"ignore_app_secrets":true},
    {"exec":["node","scripts/run-p10b-guest-guardian.js"],"ignore_app_secrets":true}
  ],
  "restart":{"policy":"no"}
}
```

This intentionally differs from the qualification process configuration; the host qualification validator must reject it. No qualification CLI/manifest/grant is used. Do not supply Fly/provider tokens to either process, inspect secret values or call provider endpoints. The public `P10B_GUEST_WINDOW` must use the exact isolated app/Machine/source/image/path and a fixed prepare-phase cutoff no later than issuedAt+five minutes, with30-second closure and30-second stop reserves. Freeze this environment **before** the start request. Do not start if the approved window is already closing. No renew/restart/retry of the same window or evidence path is allowed.

## Observation and pass criteria

1. From an already authenticated approved observer, record the stopped Machine/config/image and absence of scheduled starts, auto-destroy, conflicting init commands and extra processes. Observe metadata/logs only; do not open live SQLite, read app secrets or touch production.
2. Attach the observer before the separately approved one-time start. Record request time, start/readiness time, the configured guardian process's normal exit event and timestamp, and timestamped exact-Machine stopped readbacks. Require an observable exit timestamp; if missing, report timing unproven rather than substitute elapsed request time.
3. Terminate the primary host/control session after guest readiness to demonstrate host loss. The existing independent observer remains read-only. No emergency stop request is part of the one-owner demonstration; a stalled guest/init is outside the approved scope and would need a separate owner recovery decision.
4. The guard must exit once by stopAt minus the reserved30 seconds, with no provider call, listener or database opening. Retained guardian start/request/cancel/ack/receipt files must remain on the existing volume. With no worker candidate/handoff, the terminal receipt must correctly retain cleanup uncertainty and grant no lifecycle artifact. Do not restart merely to inspect files under this approval; missing retained-file visibility is reported as unproven evidence.
5. The exact immutable-image Machine must converge to `stopped` within30 seconds of the observed guardian exit and no later than the frozen stopAt. Polling observation interval may be at most one second; store the interval and timestamp uncertainty with the evidence. A missing/late/uncertain readback fails the demonstration. Do not infer stopped state from an SSH disconnection or exit code.
6. Preserve the public configuration, approval digest, logs, readbacks, exit-to-stopped measurement, observed cost and all uncertainty. Leave the Machine stopped and retained resources/evidence intact. No email approval follows automatically.

A normal zero-send preparation later exercises real isolated SQLite and listener cleanup with the standard two-process configuration. The one-email window additionally requires a newly reviewed qualification packet, prepared transmission/payload/alias identities, scoped provider/team/domain/key metadata, price/cost evidence and explicit permission to send exactly one message to `mathew@uckelegroup.com` from `P10B Sender <sender@p10b-e2e.uckelegroup.com>`.

## Primary platform basis

Fly documents [multiple processes within one Machine](https://docs.fly.io/machines/api/machines-resource#machine-config) through top-level Machine `config.processes`, including per-process `ignore_app_secrets`, and stops a Machine when a configured process exits successfully. Its [Machine configuration](https://docs.fly.io/machines/api/machines-resource) documents restart policy and process configuration. Fly process groups create separate Machines and are not used here. The guard needs an operational guest/kernel/init; this protocol cannot establish a guarantee for a stalled guest.
