package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func guardianInitializationFixture(t *testing.T) (map[string]interface{}, initPacket) {
	s, p := diagnosticInitializationFixture(t)
	s["version"] = "p10b-guardian-only-session-v1"
	s["operation"] = "guardian-only"
	s["maximumStarts"] = 1
	s["maximumStartWindowMs"] = 300000
	s["sessionDeadline"] = time.Now().Add(-time.Second).UTC().Add(time.Hour).Format(time.RFC3339Nano)
	start, _ := time.Parse(time.RFC3339Nano, s["startedAt"].(string))
	s["sessionDeadline"] = start.Add(time.Hour).Format(time.RFC3339Nano)
	delete(s, "diagnosticConfig")
	delete(s, "diagnosticConfigDigest")
	delete(s, "maximumDiagnosticPosts")
	delete(s, "maximumRestorationPosts")
	delete(s, "requestTimeoutMs")
	delete(s, "maximumObservationMs")
	delete(s, "maximumRunMs")
	s["recoveryPolicy"] = "acknowledged-only-stopped-runtime-v1"
	p.Version = "p10b-native-init-v1"
	return s, p
}
func guardianInitialize(t *testing.T, s map[string]interface{}, p initPacket) (*service, error, int) {
	t.Helper()
	raw, _ := json.Marshal(s)
	p.SessionCanonical = string(raw)
	p.SessionDigest = hash(raw)
	raw, _ = json.Marshal(p)
	calls := 0
	out, err := initialize(raw, func(context.Context) (requestBuilder, error) { calls++; return stoppedStatusBuilder{}, nil })
	return out, err, calls
}
func TestGuardianInitializationAcceptsOnlyOneStartDemoContract(t *testing.T) {
	for _, mode := range []string{"valid", "starts", "updates", "builds", "pushes", "qualification", "operation", "missing-qualification", "missing-builds", "baseline-version", "prepare", "config-order"} {
		t.Run(mode, func(t *testing.T) {
			s, p := guardianInitializationFixture(t)
			switch mode {
			case "starts":
				s["maximumStarts"] = 2
			case "updates":
				s["maximumStoppedConfigUpdates"] = 3
			case "builds":
				s["maximumLocalBuilds"] = 1
			case "pushes":
				s["maximumImagePushes"] = 1
			case "qualification":
				s["qualificationAllowed"] = true
			case "operation":
				s["operation"] = "no-email"
			case "missing-qualification":
				delete(s, "qualificationAllowed")
			case "missing-builds":
				delete(s, "maximumLocalBuilds")
			case "baseline-version":
				delete(s, "baselineInstanceId")
			case "config-order":
				p.Configs[0], p.Configs[1] = p.Configs[1], p.Configs[0]
			case "prepare":
				var c map[string]interface{}
				json.Unmarshal(p.Configs[1], &c)
				c["processes"] = []interface{}{map[string]interface{}{"exec": []string{"node", "server/index.js"}}, map[string]interface{}{"exec": []string{"node", "scripts/run-p10b-guest-guardian-parent.js"}, "ignore_app_secrets": true}}
				p.Configs[1], _ = json.Marshal(c)
			}
			_, err, calls := guardianInitialize(t, s, p)
			if mode == "valid" {
				if err != nil || calls != 1 {
					t.Fatalf("guardian admission failed: %v calls=%d", err, calls)
				}
			} else if err == nil || calls != 0 {
				t.Fatal("wider authority reached authentication")
			}
		})
	}
}

func TestGuardianLifecycleRequiresStoppedSettlementAndDoesNotExpireDuringRun(t *testing.T) {
	s, f := acknowledgedService(t)
	// Use the production guardian initialization path, retaining the fake SDK HTTP boundary.
	contract, p := guardianInitializationFixture(t)
	admitted, err, _ := guardianInitialize(t, contract, p)
	if err != nil {
		t.Fatal(err)
	}
	s.diagnostic.guardian = admitted.diagnostic.guardian
	s.request(context.Background(), request{ID: 1, Method: "GET", TimeoutMs: 1000})
	if !s.request(context.Background(), request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)}).OK {
		t.Fatal("candidate acknowledgement failed")
	}
	wait, _ := json.Marshal(map[string]string{"version": f.version})
	if !s.request(context.Background(), request{ID: 3, Method: "WAIT", TimeoutMs: 9000, Body: wait}).OK {
		t.Fatal("settlement failed")
	}
	f.state = "stopped"
	if !s.request(context.Background(), request{ID: 4, Method: "GET", TimeoutMs: 1000}).OK {
		t.Fatal("stopped readback failed")
	}
	if !s.diagnostic.phaseDeadline.IsZero() {
		t.Fatal("settlement window leaked into guest execution")
	}
	f.state = "started"
	if !s.request(context.Background(), request{ID: 5, Method: "GET", TimeoutMs: 1000}).OK {
		t.Fatal("guardian lifecycle observation rejected")
	}
	if s.request(context.Background(), request{ID: 6, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).OK {
		t.Fatal("restoration while running admitted")
	}
	f.state = "stopped"
	s.request(context.Background(), request{ID: 7, Method: "GET", TimeoutMs: 1000})
	if !s.request(context.Background(), request{ID: 8, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).OK {
		t.Fatal("eligible restoration rejected")
	}
	wait, _ = json.Marshal(map[string]string{"version": f.version})
	if !s.request(context.Background(), request{ID: 9, Method: "WAIT", TimeoutMs: 9000, Body: wait}).OK {
		t.Fatal("restoration settlement failed")
	}
	f.state = "stopped"
	if !s.request(context.Background(), request{ID: 10, Method: "GET", TimeoutMs: 1000}).OK {
		t.Fatal("restoration readback failed")
	}
	if s.request(context.Background(), request{ID: 11, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)}).OK || f.posts != 2 {
		t.Fatal("third update admitted")
	}
}

func TestLegacyFailedPostCannotBeRetried(t *testing.T) {
	s, f := acknowledgedService(t)
	s.diagnostic = nil
	f.primaryFailure = "loss"
	out := s.request(context.Background(), request{ID: 1, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)})
	if out.OK {
		t.Fatal("lost response accepted")
	}
	s.request(context.Background(), request{ID: 2, Method: "GET", TimeoutMs: 1000})
	if s.request(context.Background(), request{ID: 3, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).OK || f.posts != 1 {
		t.Fatal("legacy ambiguous POST permitted another mutation")
	}
}

func TestGuardianAmbiguousMutationAndSettlementRemainHeld(t *testing.T) {
	for _, mode := range []string{"loss", "unusable", "image-drift", "wrong-wait", "expired-settlement", "started-before-readback", "version-drift"} {
		t.Run(mode, func(t *testing.T) {
			s, f := acknowledgedService(t)
			s.diagnostic.guardian = true
			s.request(context.Background(), request{ID: 1, Method: "GET", TimeoutMs: 1000})
			if mode == "loss" || mode == "unusable" || mode == "image-drift" {
				f.primaryFailure = mode
			}
			ack := s.request(context.Background(), request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)})
			if ack.OK {
				switch mode {
				case "wrong-wait":
					f.waitReply = `{"ok":true,"state":"stopped","version":"other"}`
				case "expired-settlement":
					s.diagnostic.phaseDeadline = time.Now().Add(-time.Second)
				}
				wait, _ := json.Marshal(map[string]string{"version": f.version})
				s.request(context.Background(), request{ID: 3, Method: "WAIT", TimeoutMs: 9000, Body: wait})
				f.state = "stopped"
				if mode == "started-before-readback" {
					f.state = "started"
				}
				if mode == "version-drift" {
					f.version = "concurrent-version"
				}
			}
			s.request(context.Background(), request{ID: 4, Method: "GET", TimeoutMs: 1000})
			f.state = "stopped"
			s.request(context.Background(), request{ID: 5, Method: "GET", TimeoutMs: 1000})
			if s.request(context.Background(), request{ID: 6, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).OK || f.posts != 1 {
				t.Fatal("uncertainty recovered authority from later visibility")
			}
		})
	}
}
func TestGuardianAcknowledgedWindowCannotBeRenewedByWait(t *testing.T) {
	s, f := acknowledgedService(t)
	s.diagnostic.guardian = true
	s.request(context.Background(), request{ID: 1, Method: "GET", TimeoutMs: 1000})
	s.request(context.Background(), request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)})
	deadline := s.diagnostic.phaseDeadline
	wait, _ := json.Marshal(map[string]string{"version": f.version})
	s.request(context.Background(), request{ID: 3, Method: "WAIT", TimeoutMs: 9000, Body: wait})
	if !s.diagnostic.phaseDeadline.Equal(deadline) {
		t.Fatal("WAIT renewed original acknowledgement settlement deadline")
	}
}

func TestGuardianReadOnlyAdmissionAndObserverNeverAdmitPreparation(t *testing.T) {
	for _, mode := range []string{"baseline", "demo", "both", "duplicate", "prepare"} {
		t.Run(mode, func(t *testing.T) {
			contract, p := guardianInitializationFixture(t)
			p.ReadOnly = true
			p.RecoveryVerified = false
			switch mode {
			case "baseline":
				p.Configs = p.Configs[:1]
			case "demo":
				p.Configs = p.Configs[1:]
			case "duplicate":
				p.Configs = []json.RawMessage{p.Configs[1], p.Configs[1]}
			case "prepare":
				var c map[string]interface{}
				json.Unmarshal(p.Configs[1], &c)
				c["env"].(map[string]interface{})["SQLITE_PATH"] = "/data/p10b-first-mailbox-nosend-" + contract["nonce"].(string) + ".sqlite"
				p.Configs[1], _ = json.Marshal(c)
			}
			s, err, calls := guardianInitialize(t, contract, p)
			if mode == "duplicate" || mode == "prepare" {
				if err == nil || calls != 0 {
					t.Fatal("invalid observer config admitted")
				}
				return
			}
			if err != nil || calls != 1 {
				t.Fatalf("read-only scope rejected: %v", err)
			}
			if s.request(context.Background(), request{ID: 1, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(p.Configs[0], "version")}).OK {
				t.Fatal("observer admitted update")
			}
		})
	}
}
