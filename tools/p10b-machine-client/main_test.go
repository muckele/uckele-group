package main

import (
	"context"
	"encoding/json"
	"github.com/superfly/fly-go/flaps"
	"github.com/superfly/fly-go/tokens"
	"io"
	"net/http"
	"os"
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
	baseline := observedBaseline(t)
	var config map[string]interface{}
	json.Unmarshal(baseline, &config)
	image := strings.Split(config["image"].(string), "@")[1]
	session := map[string]interface{}{"version": "p10b-no-email-session-v1", "app": "uckele-group-p10b", "machineId": "0803730bd1d7e8", "sourceHead": strings.Repeat("1", 40), "nonce": strings.Repeat("c", 24), "candidateImageDigest": "sha256:" + strings.Repeat("a", 64), "baselineImageDigest": image, "baselineConfig": baseline, "ownerPermissionDigest": strings.Repeat("d", 64), "startedAt": start.UTC().Format(time.RFC3339Nano), "sessionDeadline": end.UTC().Format(time.RFC3339Nano), "maximumStarts": 2, "maximumStartWindowMs": 300000, "maximumStoppedConfigUpdates": 3, "productionReady": false, "globalAutomationPaused": true}
	c, _ := json.Marshal(session)
	p := initPacket{Version: "p10b-native-init-v1", Approved: true, ReadOnly: true, SessionCanonical: string(c), SessionDigest: hash(c), Configs: []json.RawMessage{baseline}}
	raw, _ := json.Marshal(p)
	calls := 0
	_, err := initialize(raw, func(context.Context) (requestBuilder, error) { calls++; return &fakeBuilder{}, nil })
	if err != nil || calls != 1 {
		t.Fatal("approved mock bootstrap failed")
	}
	// Changing complete baseline bytes cannot reuse its old immutable digest.
	var changed map[string]interface{}
	json.Unmarshal(baseline, &changed)
	changed["env"].(map[string]interface{})["ADMIN_AUTH_MODE"] = "password"
	session["baselineConfig"] = changed
	changedSession, _ := json.Marshal(session)
	oldCanonical := p.SessionCanonical
	p.SessionCanonical = string(changedSession)
	raw, _ = json.Marshal(p)
	_, err = initialize(raw, func(context.Context) (requestBuilder, error) { calls++; return &fakeBuilder{}, nil })
	if err == nil || calls != 1 {
		t.Fatal("changed baseline reused original session digest")
	}
	p.SessionCanonical = oldCanonical
	p.Configs = []json.RawMessage{json.RawMessage(`{}`)}
	raw, _ = json.Marshal(p)
	_, err = initialize(raw, func(context.Context) (requestBuilder, error) { calls++; return &fakeBuilder{}, nil })
	if err == nil || calls != 1 {
		t.Fatal("unbound config reached mock authentication")
	}
}

func observedBaseline(t *testing.T) json.RawMessage {
	t.Helper()
	b, err := os.ReadFile("../../test/fixtures/p10bObservedBaselineShape.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSharedPublicEnvironmentPolicyAndForbiddenKeys(t *testing.T) {
	b, err := os.ReadFile("../../test/fixtures/p10bPublicEnvironmentCases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string `json:"name"`
		Value    string `json:"value"`
		Admitted bool   `json:"admitted"`
	}
	if json.Unmarshal(b, &cases) != nil {
		t.Fatal("invalid shared policy fixture")
	}
	for _, c := range cases {
		raw, _ := json.Marshal(map[string]interface{}{"env": map[string]string{c.Name: c.Value}})
		if publicConfig(raw) != c.Admitted {
			t.Fatalf("policy mismatch for %s", c.Name)
		}
	}
	if !publicConfig(observedBaseline(t)) {
		t.Fatal("observed baseline shape denied")
	}
}

func TestPublicBaselinePreflightCapacityAndImmutableImageParity(t *testing.T) {
	b := observedBaseline(t)
	var c map[string]interface{}
	json.Unmarshal(b, &c)
	image := strings.Split(c["image"].(string), "@")[1]
	if !frozenBaseline(b, image) {
		t.Fatal("full baseline fixture denied")
	}
	for _, mutate := range []func(map[string]interface{}){
		func(c map[string]interface{}) {
			c["services"].([]interface{})[0].(map[string]interface{})["autostop"] = "off"
		},
		func(c map[string]interface{}) { c["image"] = c["image"].(string) + "@extra" },
		func(c map[string]interface{}) { c["image"] = "@" + image },
		func(c map[string]interface{}) { c["image"] = "prefix@duplicate@" + image },
		func(c map[string]interface{}) { c["auto_destroy"] = "false" },
		func(c map[string]interface{}) { c["schedule"] = false },
		func(c map[string]interface{}) { c["init"].(map[string]interface{})["exec"] = false },
		func(c map[string]interface{}) { c["init"] = false },
		func(c map[string]interface{}) { c["init"] = []interface{}{} },
		func(c map[string]interface{}) { c["env"].(map[string]interface{})["TZ"] = strings.Repeat("é", 3000) },
		func(c map[string]interface{}) {
			c["mounts"] = map[string]interface{}{"0": c["mounts"].([]interface{})[0], "length": 1}
		},
	} {
		json.Unmarshal(b, &c)
		mutate(c)
		raw, _ := json.Marshal(c)
		if frozenBaseline(raw, image) {
			t.Fatal("invalid full baseline admitted")
		}
	}
}

func TestObservedSettingsArePreservedAndFrozenInBothCandidatePhases(t *testing.T) {
	baseline := observedBaseline(t)
	start := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	source, image, nonce, owner := strings.Repeat("1", 40), "sha256:"+strings.Repeat("a", 64), strings.Repeat("c", 24), strings.Repeat("d", 64)
	if !boundConfig(baseline, baseline, source, image, nonce, owner, start, end) {
		t.Fatal("exact restoration denied")
	}
	for _, label := range []string{"demo", "prepare"} {
		var config map[string]interface{}
		json.Unmarshal(baseline, &config)
		env := config["env"].(map[string]interface{})
		// Protocol literals, independent of the production phase derivation.
		for k, v := range map[string]string{"NODE_ENV": "p10b", "P10B_QUALIFICATION_RUNTIME": "true", "STORAGE_PROVIDER": "sqlite", "P10B_QUALIFICATION_PHASE": "prepare", "DEAL_HUNTER_CIM_PROVIDER_PROFILE": "controlled-mailbox-v1", "DEAL_HUNTER_CIM_PROVIDER_ENABLED": "false", "DEAL_HUNTER_CIM_OUTREACH_PAUSED": "true", "DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED": "false", "DEAL_HUNTER_CIM_AUTOMATION_PAUSED": "true", "DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED": "false", "DEAL_HUNTER_DAILY_EMAIL_ENABLED": "false", "FOLLOW_UP_EMAIL_ENABLED": "false", "FOLLOW_UP_AI_ENABLED": "false", "DELIVERY_PROVIDER": "console"} {
			env[k] = v
		}
		kind := "nosend"
		if label == "demo" {
			kind = "watchdog"
		}
		database := "/data/p10b-first-mailbox-" + kind + "-" + nonce + ".sqlite"
		binding, _ := json.Marshal(map[string]string{"identity": label + "-" + nonce, "ownerPermissionDigest": owner})
		w, _ := json.Marshal(map[string]interface{}{"version": "p10b-guest-window-v1", "app": "uckele-group-p10b", "machineId": "0803730bd1d7e8", "sourceHead": source, "imageDigest": image, "phase": "prepare", "databasePath": database, "issuedAt": start.Format(time.RFC3339), "stopAt": start.Add(5 * time.Minute).Format(time.RFC3339), "closureGraceMs": 30000, "stopReserveMs": 30000, "runBinding": hash(binding)})
		env["SQLITE_PATH"] = database
		env["P10B_GUEST_WINDOW"] = string(w)
		config["image"] = "registry.fly.io/uckele-group-p10b@" + image
		first := map[string]interface{}{"exec": []string{"node", "server/index.js"}}
		if label == "demo" {
			first = map[string]interface{}{"exec": []string{"node", "-e", "setInterval(() => {}, 2147483647)"}, "ignore_app_secrets": true}
		}
		config["processes"] = []interface{}{first, map[string]interface{}{"exec": []string{"node", "scripts/run-p10b-guest-guardian-parent.js"}, "ignore_app_secrets": true}}
		raw, _ := json.Marshal(config)
		if !boundConfig(raw, baseline, source, image, nonce, owner, start, end) {
			t.Fatal("derived phase denied", label)
		}
		for _, k := range strings.Fields("ADMIN_ALLOW_PASSWORD_AUTH ADMIN_AUTH_MODE ANALYTICS_ENABLED BACKUP_ENABLED OUTBOUND_HTTP_TIMEOUT_MS PUBLIC_SITE_URL SECURE_DOCUMENTS_STORAGE_DIR") {
			value := env[k]
			delete(env, k)
			changed, _ := json.Marshal(config)
			if boundConfig(changed, baseline, source, image, nonce, owner, start, end) {
				t.Fatal("missing baseline key admitted", k)
			}
			env[k] = value
			var restored map[string]interface{}
			json.Unmarshal(baseline, &restored)
			delete(restored["env"].(map[string]interface{}), k)
			changed, _ = json.Marshal(restored)
			if boundConfig(changed, baseline, source, image, nonce, owner, start, end) {
				t.Fatal("partial restoration admitted", k)
			}
		}
		config["image"] = "registry.fly.io/uckele-group-p10b@sha256:" + strings.Repeat("f", 64)
		changed, _ := json.Marshal(config)
		if boundConfig(changed, baseline, source, image, nonce, owner, start, end) {
			t.Fatal("candidate image drift admitted")
		}
	}
}
