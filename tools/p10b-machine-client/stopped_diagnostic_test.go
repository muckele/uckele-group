package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStoppedDiagnosticNativeStatusAndWriteLimits(t *testing.T) {
	builder := stoppedStatusBuilder{}
	baseline := json.RawMessage(`{"image":"registry.fly.io/uckele-group-p10b@sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629"}`)
	candidate := json.RawMessage(`{"image":"registry.fly.io/uckele-group-p10b@sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc"}`)
	b, _ := canonical(baseline)
	c, _ := canonical(candidate)
	for _, status := range []int{200, 401, 409, 422, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			s := &service{builder: builder, client: stoppedStatusDoer{status: status}, deadline: time.Now().Add(time.Minute),
				allowedConfig: map[string]bool{hash(b): true, hash(c): true}}
			enableStoppedDiagnostic(s, b, c, "old-version")
			raw, _ := json.Marshal(map[string]interface{}{"config": candidate, "current_version": "old-version", "skip_launch": true})
			denied := s.request(context.Background(), request{ID: 1, Method: "POST", TimeoutMs: 10000, Body: raw})
			if denied.Error != "request-denied" {
				t.Fatal("GET must precede POST")
			}
			s.diagnostic.lastConfig = hash(b)
			s.diagnostic.lastVersion = "old-version"
			s.diagnostic.lastStopped = true
			s.diagnostic.lastAt = time.Now()
			result := s.request(context.Background(), request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: raw})
			encoded, _ := json.Marshal(result)
			if !strings.Contains(string(encoded), `"httpStatus":`+jsonNumber(status)) || strings.Contains(string(encoded), "private-canary") {
				t.Fatalf("closed status missing: %s", encoded)
			}
			repeated := s.request(context.Background(), request{ID: 3, Method: "POST", TimeoutMs: 10000, Body: raw})
			if repeated.Error != "request-denied" {
				t.Fatal("diagnostic POST replay admitted")
			}
		})
	}
}

type stoppedStatusBuilder struct{}

func (stoppedStatusBuilder) NewRequest(ctx context.Context, method, path string, body interface{}, _ map[string][]string) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, method, "https://api.machines.dev/v1"+path, nil)
}

type stoppedStatusDoer struct{ status int }

func (f stoppedStatusDoer) Do(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: f.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":"private-canary"}`))}, nil
}
func jsonNumber(v int) string { b, _ := json.Marshal(v); return string(b) }

func diagnosticInitializationFixture(t *testing.T) (map[string]interface{}, initPacket) {
	t.Helper()
	raw, err := os.ReadFile("../../test/fixtures/p10bStoppedUpdateContract.json")
	if err != nil {
		t.Fatal(err)
	}
	var f map[string]interface{}
	if json.Unmarshal(raw, &f) != nil {
		t.Fatal("fixture")
	}
	candidate := f["config"].(map[string]interface{})
	env := candidate["env"].(map[string]interface{})
	var window map[string]interface{}
	json.Unmarshal([]byte(env["P10B_GUEST_WINDOW"].(string)), &window)
	start := time.Now().Add(-time.Second).UTC()
	end := start.Add(15 * time.Minute)
	nonce := "103e41746bf89e7e2dec9c5d"
	owner := strings.Repeat("a", 64)
	window["issuedAt"] = start.Format(time.RFC3339Nano)
	window["stopAt"] = start.Add(5 * time.Minute).Format(time.RFC3339Nano)
	binding, _ := canonical([]byte(`{"identity":"demo-` + nonce + `","ownerPermissionDigest":"` + owner + `"}`))
	window["runBinding"] = hash(binding)
	w, _ := json.Marshal(window)
	w, _ = canonical(w)
	env["P10B_GUEST_WINDOW"] = string(w)
	c, _ := json.Marshal(candidate)
	c, _ = canonical(c)
	b, _ := json.Marshal(f["baseline"])
	b, _ = canonical(b)
	session := map[string]interface{}{"version": "p10b-stopped-update-session-v1", "operation": "stopped-update-diagnostic", "app": "uckele-group-p10b", "machineId": "0803730bd1d7e8", "volumeId": "vol_vwnkpex1k3yx9dnv", "sourceHead": "c4944a46ac362cdcd002e077d5533b4b0843b1d0", "candidateImageDigest": "sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc", "baselineImageDigest": "sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629", "baselineConfig": json.RawMessage(b), "diagnosticConfig": json.RawMessage(c), "diagnosticConfigDigest": hash(c), "baselineInstanceId": f["currentVersion"], "nonce": nonce, "ownerPermissionDigest": owner, "startedAt": start.Format(time.RFC3339Nano), "sessionDeadline": end.Format(time.RFC3339Nano), "maximumStarts": 0, "maximumStartWindowMs": 0, "qualificationAllowed": false, "maximumDiagnosticPosts": 1, "maximumRestorationPosts": 1, "maximumStoppedConfigUpdates": 2, "requestTimeoutMs": 10000, "maximumObservationMs": 10000, "maximumRunMs": 120000, "maximumLocalBuilds": 0, "maximumImagePushes": 0, "productionReady": false, "globalAutomationPaused": true}
	return session, initPacket{Version: "p10b-stopped-native-init-v1", Approved: true, RecoveryVerified: true, Configs: []json.RawMessage{b, c}}
}
func TestStoppedDiagnosticInitializationRejectsWiderOrMalformedAuthorityBeforeAuthentication(t *testing.T) {
	cases := []string{"valid", "operation", "legacy", "starts", "qualification", "posts", "timeout", "machine", "version", "owner", "baseline-hard-off", "config-sequence", "recovery", "approval"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			s, p := diagnosticInitializationFixture(t)
			switch name {
			case "operation":
				s["operation"] = "qualification"
			case "legacy":
				s["version"] = "p10b-no-email-session-v1"
			case "starts":
				s["maximumStarts"] = 2
			case "qualification":
				s["qualificationAllowed"] = true
			case "posts":
				s["maximumDiagnosticPosts"] = 2
			case "timeout":
				s["requestTimeoutMs"] = 1000
			case "machine":
				s["machineId"] = "other"
			case "version":
				s["baselineInstanceId"] = "invalid/version"
			case "owner":
				s["ownerPermissionDigest"] = "invalid-owner"
			case "baseline-hard-off":
				var baseline map[string]interface{}
				json.Unmarshal(s["baselineConfig"].(json.RawMessage), &baseline)
				baseline["env"].(map[string]interface{})["DEAL_HUNTER_CIM_PROVIDER_ENABLED"] = "true"
				b, _ := json.Marshal(baseline)
				b, _ = canonical(b)
				s["baselineConfig"] = json.RawMessage(b)
				p.Configs[0] = b
			case "config-sequence":
				p.Configs[0], p.Configs[1] = p.Configs[1], p.Configs[0]
			case "recovery":
				p.RecoveryVerified = false
			case "approval":
				p.Approved = false
			}
			c, _ := json.Marshal(s)
			p.SessionCanonical = string(c)
			p.SessionDigest = hash(c)
			raw, _ := json.Marshal(p)
			calls := 0
			_, err := initializeStoppedDiagnostic(raw, func(context.Context) (requestBuilder, error) { calls++; return &fakeBuilder{}, nil })
			if name == "valid" {
				if err != nil || calls != 1 {
					t.Fatalf("valid injected initialization failed: %v calls%d", err, calls)
				}
			} else if err == nil || calls != 0 {
				t.Fatal("invalid authority reached authentication")
			}
		})
	}
}
