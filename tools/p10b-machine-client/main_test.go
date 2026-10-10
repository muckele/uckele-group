package main

import (
	"context"
	"encoding/json"
	"github.com/superfly/fly-go/flaps"
	"github.com/superfly/fly-go/tokens"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type fakeBuilder struct{ calls int }

func (f *fakeBuilder) NewRequest(ctx context.Context, method, path string, in interface{}, headers map[string][]string) (*http.Request, error) {
	f.calls++
	req, _ := http.NewRequestWithContext(ctx, method, "https://api.machines.dev/v1"+path, strings.NewReader(string(in.(json.RawMessage))))
	req.Header.Set("Authorization", "Bearer synthetic-test-auth-only")
	return req, nil
}

type fakeDoer struct {
	calls  int
	body   string
	method string
}

func (f *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	f.calls++
	b, _ := io.ReadAll(req.Body)
	f.body = string(b)
	f.method = req.Method
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"id":"0803730bd1d7e8","state":"stopped","instance_id":"new-version","region":"ewr","config":{},"image_ref":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}`))}, nil
}
func TestExactUpdateHasFrozenVersionAndNoRetry(t *testing.T) {
	b := &fakeBuilder{}
	d := &fakeDoer{}
	s := &service{builder: b, client: d, deadline: time.Now().Add(time.Minute), allowedConfig: map[string]bool{hash([]byte(`{}`)): true}}
	result := s.request(context.Background(), request{ID: 1, Method: "POST", TimeoutMs: 500, Body: []byte(`{"config":{},"current_version":"frozen-version","skip_launch":true}`)})
	if !result.OK || d.calls != 1 || !strings.Contains(d.body, `"current_version":"frozen-version"`) || !strings.Contains(d.body, `"skip_launch":true`) {
		t.Fatalf("frozen update not sent once: %#v", result)
	}
	if strings.Contains(result.Error, "synthetic") {
		t.Fatal("auth leaked")
	}
}
func TestReadOnlyOrUnboundedRequestsNeverReachClient(t *testing.T) {
	for _, r := range []request{{Method: "DELETE", TimeoutMs: 500}, {Method: "GET", TimeoutMs: 11000}, {Method: "POST", TimeoutMs: 500, Body: []byte(`{"skip_launch":false}`)}} {
		b := &fakeBuilder{}
		d := &fakeDoer{}
		s := &service{builder: b, client: d, readOnly: true, deadline: time.Now().Add(time.Minute)}
		if s.request(context.Background(), r).OK || b.calls != 0 || d.calls != 0 {
			t.Fatal("inadmissible request reached authenticated boundary")
		}
	}
}
func TestUnapprovedInitializationNeverLoadsAuthentication(t *testing.T) {
	calls := 0
	_, err := initialize([]byte(`{"version":"p10b-native-init-v1","approved":false}`), func(context.Context) (requestBuilder, error) { calls++; return &fakeBuilder{}, nil })
	if err == nil || calls != 0 {
		t.Fatal("held packet constructed authentication")
	}
}

func TestOfficialSDKBuildsFrozenDTOWithoutAuthenticationIO(t *testing.T) {
	t.Setenv("FLY_FLAPS_BASE_URL", "https://api.machines.dev")
	b, err := flaps.NewWithOptions(context.Background(), flaps.NewClientOpts{Tokens: tokens.Parse("synthetic-offline-test-only")})
	if err != nil {
		t.Fatal("mock SDK bootstrap failed")
	}
	d := &fakeDoer{}
	s := &service{builder: b, client: d, deadline: time.Now().Add(time.Minute), allowedConfig: map[string]bool{hash([]byte(`{}`)): true}}
	r := s.request(context.Background(), request{ID: 1, Method: "POST", TimeoutMs: 500, Body: []byte(`{"config":{},"current_version":"frozen-version","skip_launch":true}`)})
	if !r.OK || d.calls != 1 || !strings.Contains(d.body, `"current_version":"frozen-version"`) || !strings.Contains(d.body, `"skip_launch":true`) {
		t.Fatal("SDK changed the exact frozen DTO")
	}
}
func TestLifecycleProjectionRejectsNestedNullAndCanaryFields(t *testing.T) {
	for _, v := range []string{`{"guest_error":null,"error":""}`, `{"guest_error":{"canary":"private"},"error":""}`, `{"guest_error":"private-canary","error":""}`} {
		raw := []byte(`[{"type":"exit","status":"stopped","request":{"exit_event":{"exited_at":"2026-10-10T04:06:01.334578044Z","requested_stop":false,"restarting":false,"oom_killed":false,"guest_exit_code":0,"exit_code":0,"guest_signal":-1,"signal":-1,` + strings.TrimSuffix(strings.TrimPrefix(v, "{"), "}") + `}}}]`)
		out, _ := json.Marshal(safeEvents(raw))
		if strings.Contains(string(out), "private") || strings.Contains(string(out), "null") {
			t.Fatal("untyped lifecycle data retained")
		}
		if strings.Contains(v, "null") && string(out) != "[]" {
			t.Fatal("null became successful empty error")
		}
	}
}
func TestConfigMustBeFrozenBaselineOrDerivedPublicPhase(t *testing.T) {
	start := time.Now()
	end := start.Add(time.Hour)
	if boundConfig([]byte(`{"image":"other"}`), []byte(`{}`), strings.Repeat("1", 40), "sha256:"+strings.Repeat("a", 64), strings.Repeat("c", 24), strings.Repeat("d", 64), start, end) {
		t.Fatal("arbitrary config admitted")
	}
	if publicConfig([]byte(`{"env":{"DATABASE_URL":"synthetic-private-canary"}}`)) {
		t.Fatal("private environment admitted")
	}
}

func TestApprovedInitializationUsesOnlyInjectedFactory(t *testing.T) {
	start := time.Now().Add(-time.Second)
	end := start.Add(time.Hour)
	image := "sha256:" + strings.Repeat("b", 64)
	baseline := json.RawMessage(`{"image":"registry.fly.io/uckele-group@` + image + `","env":{},"guest":{"cpu_kind":"shared","cpus":1,"memory_mb":512},"restart":{"policy":"no"},"mounts":[{"volume":"vol_vwnkpex1k3yx9dnv","path":"/data"}],"services":[{"autostart":false,"autostop":false,"internal_port":8787}]}`)
	session := map[string]interface{}{"version": "p10b-no-email-session-v1", "app": "uckele-group-p10b", "machineId": "0803730bd1d7e8", "sourceHead": strings.Repeat("1", 40), "nonce": strings.Repeat("c", 24), "candidateImageDigest": "sha256:" + strings.Repeat("a", 64), "baselineImageDigest": image, "baselineConfig": baseline, "ownerPermissionDigest": strings.Repeat("d", 64), "startedAt": start.UTC().Format(time.RFC3339Nano), "sessionDeadline": end.UTC().Format(time.RFC3339Nano), "maximumStarts": 2, "maximumStartWindowMs": 300000, "maximumStoppedConfigUpdates": 3, "productionReady": false, "globalAutomationPaused": true}
	c, _ := json.Marshal(session)
	p := initPacket{Version: "p10b-native-init-v1", Approved: true, ReadOnly: true, SessionCanonical: string(c), SessionDigest: hash(c), Configs: []json.RawMessage{baseline}}
	raw, _ := json.Marshal(p)
	calls := 0
	_, err := initialize(raw, func(context.Context) (requestBuilder, error) { calls++; return &fakeBuilder{}, nil })
	if err != nil || calls != 1 {
		t.Fatal("approved mock bootstrap failed")
	}
	p.Configs = []json.RawMessage{json.RawMessage(`{}`)}
	raw, _ = json.Marshal(p)
	_, err = initialize(raw, func(context.Context) (requestBuilder, error) { calls++; return &fakeBuilder{}, nil })
	if err == nil || calls != 1 {
		t.Fatal("unbound config reached mock authentication")
	}
}
