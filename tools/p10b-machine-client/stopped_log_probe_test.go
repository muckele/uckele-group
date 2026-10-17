package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func stoppedLogProbeFixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("../../test/fixtures/p10bStoppedUpdateContract.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Baseline json.RawMessage `json:"baseline"`
		Instance string          `json:"currentVersion"`
	}
	if json.Unmarshal(raw, &fixture) != nil {
		t.Fatal("fixture")
	}
	baseline, _ := canonical(fixture.Baseline)
	issued := time.Now().Add(-time.Second).UTC().Truncate(time.Millisecond)
	p := stoppedLogProbeProfile{Version: "p10b-stopped-log-probe-v1", Operation: "stopped-log-probe", App: "uckele-group-p10b", Machine: "0803730bd1d7e8", Volume: "vol_vwnkpex1k3yx9dnv", Source: strings.Repeat("a", 40), Native: strings.Repeat("b", 64), Nonce: strings.Repeat("c", 24), Issued: issued.Format("2006-01-02T15:04:05.000Z"), Expires: issued.Add(30 * time.Second).Format("2006-01-02T15:04:05.000Z"), Directory: "/tmp/p10b-stopped-log-probe-fixture", Baseline: baseline, BaselineDigest: hash(baseline), BaselineImage: "sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629", BaselineInstance: fixture.Instance, MachineReads: 2, LogReads: 2, Aggregate: 30000, Cleanup: 3000, FirstLog: 5000, SteadyLog: 700, MachineTimeout: 1000, Paused: true}
	probe, _ := json.Marshal(p)
	probe, _ = canonical(probe)
	a := stoppedLogProbeApproval{Version: "p10b-stopped-log-probe-approval-v1", Approved: true, ProbeDigest: hash(probe), Source: p.Source, Native: p.Native, Expires: p.Expires, ApprovedAt: issued.Format("2006-01-02T15:04:05.000Z")}
	approval, _ := json.Marshal(a)
	out, _ := json.Marshal(map[string]json.RawMessage{"probe": probe, "approval": approval})
	return out
}

func TestStoppedLogProbeProjectionNeverReturnsGuardianOrApplicationText(t *testing.T) {
	s, err := initializeStoppedLogProbe(context.Background(), stoppedLogProbeFixture(t), time.Now(), func(context.Context) (doer, error) {
		return logDoerFunc(func(*http.Request) (*http.Response, error) { return nil, nil }), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"empty", "application", "wrong-window", "empty-window"} {
		t.Run(mode, func(t *testing.T) {
			rows := []interface{}{}
			if mode == "application" {
				rows = append(rows, map[string]interface{}{"attributes": map[string]interface{}{"message": "private-canary", "instance": "0803730bd1d7e8", "region": "ewr"}})
			}
			if mode == "wrong-window" || mode == "empty-window" {
				window := strings.Repeat("a", 64)
				if mode == "empty-window" {
					window = ""
				}
				row := guardianLogFixture(t, &logService{windowDigest: window}, "2026-10-18T00:00:00.123456789Z")
				rows = append(rows, row)
			}
			raw, _ := json.Marshal(map[string]interface{}{"data": rows, "meta": map[string]string{"next_token": "private-cursor"}})
			if mode == "empty-window" {
				old, err := projectLogBody(raw, "")
				if err != nil || len(old) != 1 {
					t.Fatal("fixturefailedtoreproduceemptydigestguardian")
				}
			}
			out, err := s.logs.project(raw, "")
			if err != nil || len(out) != 0 || s.batchEmpty != (mode == "empty") {
				t.Fatalf("projectionmode=%s empty=%t rows=%d err=%v", mode, s.batchEmpty, len(out), err)
			}
		})
	}
}

func TestStoppedLogProbeRestrictedSDKTransportUsesOnlyFourFixedReads(t *testing.T) {
	for _, mode := range []string{"success", "503", "redirect", "reset", "slow-headers", "slow-body"} {
		t.Run(mode, func(t *testing.T) {
			raw := stoppedLogProbeFixture(t)
			var packet struct {
				Probe stoppedLogProbeProfile `json:"probe"`
			}
			json.Unmarshal(raw, &packet)
			p := packet.Probe
			var calls atomic.Int32
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.ProtoMajor != 1 || r.Header.Get("Accept-Encoding") != "" || r.Header.Get("Authorization") == "" {
					t.Error("SDKtransportwidened")
				}
				machine := r.Host == "api.machines.dev" && r.URL.RequestURI() == "/v1/apps/uckele-group-p10b/machines/0803730bd1d7e8"
				logs := r.Host == "api.fly.io" && r.URL.RequestURI() == "/api/v1/apps/uckele-group-p10b/logs?instance=0803730bd1d7e8&next_token="
				if !machine && !logs {
					t.Error("wrongtarget")
				}
				switch mode {
				case "503":
					w.WriteHeader(503)
					return
				case "redirect":
					w.Header().Set("Location", "https://private.invalid")
					w.WriteHeader(302)
					return
				case "reset":
					c, _, e := w.(http.Hijacker).Hijack()
					if e == nil {
						c.Close()
					}
					return
				case "slow-headers":
					<-r.Context().Done()
					return
				case "slow-body":
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
					<-r.Context().Done()
					return
				}
				if machine {
					body, _ := json.Marshal(map[string]interface{}{"id": "0803730bd1d7e8", "region": "ewr", "state": "stopped", "instance_id": p.BaselineInstance, "config": p.Baseline, "image_ref": map[string]string{"digest": p.BaselineImage}, "private": "private-canary"})
					w.Write(body)
				} else {
					io.WriteString(w, `{"data":[],"meta":{"next_token":"private-cursor"}}`)
				}
			}))
			server.EnableHTTP2 = true
			server.StartTLS()
			defer server.Close()
			transport := restrictedLogTransport()
			defer transport.CloseIdleConnections()
			pool := x509.NewCertPool()
			pool.AddCert(server.Certificate())
			transport.TLSClientConfig.RootCAs = pool
			transport.TLSClientConfig.ServerName = "example.com"
			address, _ := url.Parse(server.URL)
			transport.DialContext = func(ctx context.Context, network, addressRequested string) (net.Conn, error) {
				if addressRequested != "api.fly.io:443" && addressRequested != "api.machines.dev:443" {
					return nil, errors.New("wrongdialtarget")
				}
				return (&net.Dialer{}).DialContext(ctx, "tcp", address.Host)
			}
			client, e := newStoppedLogProbeHTTP("synthetic-probe-private-canary", transport)
			if e != nil {
				t.Fatal(e)
			}
			s, e := initializeStoppedLogProbe(context.Background(), raw, time.Now(), func(context.Context) (doer, error) { return client, nil })
			if e != nil {
				t.Fatal(e)
			}
			for id, operation := range stoppedLogProbeOperations {
				result := s.request(context.Background(), stoppedLogProbeRequest{ID: id + 1, Operation: operation})
				encoded, _ := json.Marshal(result)
				if strings.Contains(string(encoded), "private") {
					t.Fatal("privatebytesescaped")
				}
				if mode != "success" {
					if result.Type != "error" || calls.Load() != 1 {
						t.Fatal("failureaccepted/retried")
					}
					if s.request(context.Background(), stoppedLogProbeRequest{ID: 2, Operation: "LOG_FIRST"}).Type != "error" || calls.Load() != 1 {
						t.Fatal("failurecontinued")
					}
					break
				}
				if result.Type != "success" {
					t.Fatalf("validstepfailed%s", encoded)
				}
			}
			if mode == "success" && calls.Load() != 4 {
				t.Fatal("wrongquotacount")
			}
		})
	}
}

func TestStoppedLogProbeInputEOFCancelsInFlightRead(t *testing.T) {
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	defer writer.Close()
	defer reader.Close()
	started := make(chan struct{})
	cancelled := make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		defer output.Close()
		finished <- serveStoppedLogProbe(context.Background(), input, output, func(context.Context) (doer, error) {
			return logDoerFunc(func(r *http.Request) (*http.Response, error) {
				close(started)
				<-r.Context().Done()
				close(cancelled)
				return nil, r.Context().Err()
			}), nil
		})
	}()
	raw := stoppedLogProbeFixture(t)
	go func() { writer.Write(append(raw, '\n')) }()
	decoder := json.NewDecoder(reader)
	var ready map[string]interface{}
	if decoder.Decode(&ready) != nil || ready["type"] != "ready" {
		t.Fatal("readyabsent")
	}
	go func() { io.WriteString(writer, "{\"id\":1,\"operation\":\"BASELINE_BEFORE\"}\n") }()
	<-started
	writer.Close()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("EOFdidnotcancelHTTP")
	}
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("EOFbecamesuccess")
		}
	case <-time.After(time.Second):
		t.Fatal("EOFdidnotfinish")
	}
}

func retimedStoppedLogProbeFixture(t *testing.T, issued time.Time) []byte {
	var packet map[string]json.RawMessage
	json.Unmarshal(stoppedLogProbeFixture(t), &packet)
	var p, a map[string]interface{}
	json.Unmarshal(packet["probe"], &p)
	json.Unmarshal(packet["approval"], &a)
	p["issuedAt"] = issued.UTC().Format("2006-01-02T15:04:05.000Z")
	p["expiresAt"] = issued.Add(30 * time.Second).UTC().Format("2006-01-02T15:04:05.000Z")
	probe, _ := json.Marshal(p)
	probe, _ = canonical(probe)
	a["probeDigest"] = hash(probe)
	a["approvedAt"] = p["issuedAt"]
	a["expiresAt"] = p["expiresAt"]
	approval, _ := json.Marshal(a)
	out, _ := json.Marshal(map[string]json.RawMessage{"probe": probe, "approval": approval})
	return out
}

func TestStoppedLogProbeFactoryCannotRenewOriginalInitializationDeadline(t *testing.T) {
	anchor := time.Now().Add(-10*time.Second + 50*time.Millisecond)
	raw := retimedStoppedLogProbeFixture(t, anchor.Add(-time.Second))
	release := make(chan struct{})
	defer close(release)
	finished := make(chan error, 1)
	go func() {
		_, err := initializeStoppedLogProbe(context.Background(), raw, anchor, func(ctx context.Context) (doer, error) {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				return nil, errors.New("released")
			}
		})
		finished <- err
	}()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("expiredinitializationaccepted")
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("factoryreceivedrenewedinitializationdeadline")
	}
}

func TestStoppedLogProbeEOFCancelsInitializationFactory(t *testing.T) {
	input, writer := io.Pipe()
	defer writer.Close()
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	finished := make(chan error, 1)
	go func() {
		finished <- serveStoppedLogProbe(context.Background(), input, io.Discard, func(ctx context.Context) (doer, error) {
			close(started)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				return nil, errors.New("released")
			}
		})
	}()
	raw := stoppedLogProbeFixture(t)
	go func() { writer.Write(append(raw, '\n')) }()
	<-started
	writer.Close()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("EOFinitializationaccepted")
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("EOFdidnotcancelinitializationfactory")
	}
}

type stoppedLogProbeBlockedWriter struct{ release chan struct{} }

func (w stoppedLogProbeBlockedWriter) Write(b []byte) (int, error) { <-w.release; return len(b), nil }
func TestStoppedLogProbeOutputPublicationHasItsOriginalDeadline(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
	defer cancel()
	began := time.Now()
	if writeStoppedLogProbeFrame(ctx, json.NewEncoder(stoppedLogProbeBlockedWriter{release: release}), map[string]bool{"ok": true}) == nil || time.Since(began) > 300*time.Millisecond {
		t.Fatal("publicationdeadlineextended")
	}
}

func TestStoppedLogProbeAuthorityDenialHasNoAuthentication(t *testing.T) {
	for _, mode := range []string{"runtime-profile", "runtime-approval", "unapproved", "target", "volume", "starts", "updates", "reads", "log-reads", "budget", "production", "qualification", "provider", "email", "paused", "nonce", "source", "native", "baseline-digest", "baseline-image", "baseline-instance", "directory", "future", "expired", "duration", "approval-source", "approval-digest", "unknown", "missing", "duplicate", "trailing"} {
		t.Run(mode, func(t *testing.T) {
			raw := stoppedLogProbeFixture(t)
			var packet map[string]json.RawMessage
			json.Unmarshal(raw, &packet)
			var p, a map[string]interface{}
			json.Unmarshal(packet["probe"], &p)
			json.Unmarshal(packet["approval"], &a)
			switch mode {
			case "runtime-profile":
				p["version"] = "p10b-guardian-only-session-v1"
			case "runtime-approval":
				a["version"] = "p10b-no-email-approval-v1"
			case "unapproved":
				a["approved"] = false
			case "target":
				p["machineId"] = "other"
			case "volume":
				p["volumeId"] = "other"
			case "starts":
				p["maximumStarts"] = 1
			case "updates":
				p["maximumStoppedConfigUpdates"] = 1
			case "reads":
				p["maximumMachineReads"] = 3
			case "log-reads":
				p["maximumLogReads"] = 3
			case "budget":
				p["cleanupReserveMs"] = 0
			case "production":
				p["productionReady"] = true
			case "qualification":
				p["qualificationAllowed"] = true
			case "provider":
				p["providerCalls"] = 1
			case "email":
				p["emails"] = 1
			case "paused":
				p["globalAutomationPaused"] = false
			case "nonce":
				p["nonce"] = "bad"
			case "source":
				p["hostSourceHead"] = "bad"
			case "native":
				p["nativeClientSha256"] = "bad"
			case "baseline-digest":
				p["baselineConfigDigest"] = strings.Repeat("d", 64)
			case "baseline-image":
				p["baselineImageDigest"] = "sha256:" + strings.Repeat("d", 64)
			case "baseline-instance":
				p["baselineInstanceId"] = "bad/version"
			case "directory":
				p["evidenceDirectory"] = "/tmp/../unsafe"
			case "future", "expired", "duration":
				start := time.Now().UTC().Add(time.Hour)
				if mode == "expired" {
					start = start.Add(-2 * time.Hour)
				}
				if mode == "duration" {
					start = time.Now().UTC().Add(-time.Second)
				}
				p["issuedAt"] = start.Format("2006-01-02T15:04:05.000Z")
				end := start.Add(30 * time.Second)
				if mode == "duration" {
					end = end.Add(time.Millisecond)
				}
				p["expiresAt"] = end.Format("2006-01-02T15:04:05.000Z")
				a["expiresAt"] = p["expiresAt"]
				a["approvedAt"] = p["issuedAt"]
			case "approval-source":
				a["hostSourceHead"] = strings.Repeat("d", 40)
			case "unknown":
				p["url"] = "https://private.invalid"
			case "missing":
				delete(p, "maximumStarts")
			}
			probe, _ := json.Marshal(p)
			probe, _ = canonical(probe)
			a["probeDigest"] = hash(probe)
			if mode == "approval-digest" {
				a["probeDigest"] = strings.Repeat("d", 64)
			}
			approval, _ := json.Marshal(a)
			raw, _ = json.Marshal(map[string]json.RawMessage{"probe": probe, "approval": approval})
			if mode == "duplicate" {
				raw = append([]byte(`{"probe":{},`), raw[1:]...)
			}
			if mode == "trailing" {
				raw = append(raw, []byte(`{}`)...)
			}
			calls := 0
			_, err := initializeStoppedLogProbe(context.Background(), raw, time.Now(), func(context.Context) (doer, error) { calls++; return nil, nil })
			if err == nil || calls != 0 {
				t.Fatalf("denial mode=%s authcalls=%d err=%v", mode, calls, err)
			}
		})
	}
}

func TestStoppedLogProbeFourStepsAreReadOnlyAndPrivate(t *testing.T) {
	var p struct {
		Probe stoppedLogProbeProfile `json:"probe"`
	}
	raw := stoppedLogProbeFixture(t)
	json.Unmarshal(raw, &p)
	calls := []string{}
	s, err := initializeStoppedLogProbe(context.Background(), raw, time.Now(), func(context.Context) (doer, error) {
		return logDoerFunc(func(r *http.Request) (*http.Response, error) {
			if r.Method != "GET" || r.Body != nil || r.GetBody != nil {
				t.Fatal("mutation")
			}
			calls = append(calls, r.URL.String())
			body := `{"data":[]}`
			if r.URL.String() == stoppedLogProbeMachineEndpoint {
				m := map[string]interface{}{"id": "0803730bd1d7e8", "region": "ewr", "state": "stopped", "instance_id": p.Probe.BaselineInstance, "config": p.Probe.Baseline, "image_ref": map[string]string{"digest": p.Probe.BaselineImage}, "private": "private-canary"}
				b, _ := json.Marshal(m)
				body = string(b)
			} else if len(calls) == 3 {
				body = `{"data":[{"attributes":{"message":"private-canary","instance":"other","region":"ord"}}],"meta":{"next_token":"private-cursor"}}`
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
		}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for id, operation := range stoppedLogProbeOperations {
		out := s.request(context.Background(), stoppedLogProbeRequest{ID: id + 1, Operation: operation})
		encoded, _ := json.Marshal(out)
		if out.Type != "success" || strings.Contains(string(encoded), "private") || strings.Contains(string(encoded), "message") || strings.Contains(string(encoded), "config\"") {
			t.Fatalf("phase%d result%s", id, encoded)
		}
		if operation == "LOG_FIRST" && out.Observation.ProviderBatchEmpty == nil {
			t.Fatal("empty fact absent")
		}
		if operation == "LOG_FIRST" && !*out.Observation.ProviderBatchEmpty {
			t.Fatal("emptyfalse")
		}
		if operation == "LOG_STEADY" && (out.Observation.ProviderBatchEmpty == nil || *out.Observation.ProviderBatchEmpty) {
			t.Fatal("nonemptyfilteredbecameempty")
		}
	}
	if len(calls) != 4 || calls[0] != stoppedLogProbeMachineEndpoint || calls[1] != logEndpoint || calls[2] != logEndpoint || calls[3] != stoppedLogProbeMachineEndpoint {
		t.Fatal("wrongdispatchsequence")
	}
	if s.request(context.Background(), stoppedLogProbeRequest{ID: 5, Operation: "BASELINE_BEFORE"}).Type != "error" || len(calls) != 4 {
		t.Fatal("replay")
	}
}

func TestStoppedLogProbeBaselineFailuresPoisonEveryFollowingStep(t *testing.T) {
	for _, mode := range []string{"target", "region", "started", "instance", "resolved-image", "volume", "hard-off", "runtime-window", "root-error", "root-errors", "duplicate", "trailing", "oversize", "encoding", "status"} {
		t.Run(mode, func(t *testing.T) {
			raw := stoppedLogProbeFixture(t)
			var packet struct {
				Probe stoppedLogProbeProfile `json:"probe"`
			}
			json.Unmarshal(raw, &packet)
			p := packet.Probe
			var config map[string]interface{}
			json.Unmarshal(p.Baseline, &config)
			m := map[string]interface{}{"id": "0803730bd1d7e8", "region": "ewr", "state": "stopped", "instance_id": p.BaselineInstance, "config": config, "image_ref": map[string]string{"digest": p.BaselineImage}}
			switch mode {
			case "target":
				m["id"] = "other"
			case "region":
				m["region"] = "ord"
			case "started":
				m["state"] = "started"
			case "instance":
				m["instance_id"] = "different-instance"
			case "resolved-image":
				m["image_ref"] = map[string]string{"digest": "sha256:" + strings.Repeat("d", 64)}
			case "volume":
				config["mounts"].([]interface{})[0].(map[string]interface{})["volume"] = "other"
			case "hard-off":
				config["env"].(map[string]interface{})["DEAL_HUNTER_CIM_PROVIDER_ENABLED"] = "true"
			case "runtime-window":
				config["env"].(map[string]interface{})["P10B_GUEST_WINDOW"] = "private-canary"
			case "root-error":
				m["error"] = nil
			case "root-errors":
				m["errors"] = []interface{}{"private-canary"}
			}
			body, _ := json.Marshal(m)
			if mode == "duplicate" {
				body = append([]byte(`{"state":"stopped",`), body[1:]...)
			}
			if mode == "trailing" {
				body = append(body, []byte(`{}`)...)
			}
			if mode == "oversize" {
				body = []byte(strings.Repeat("x", 131073))
			}
			calls := 0
			s, err := initializeStoppedLogProbe(context.Background(), raw, time.Now(), func(context.Context) (doer, error) {
				return logDoerFunc(func(*http.Request) (*http.Response, error) {
					calls++
					status := 200
					if mode == "status" {
						status = 201
					}
					headers := make(http.Header)
					if mode == "encoding" {
						headers.Set("Content-Encoding", "gzip")
					}
					return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
				}), nil
			})
			if err != nil {
				t.Fatal(err)
			}
			out := s.request(context.Background(), stoppedLogProbeRequest{ID: 1, Operation: "BASELINE_BEFORE"})
			if out.Type != "error" || out.Observation != nil {
				t.Fatal("wrongbaselineaccepted")
			}
			if s.request(context.Background(), stoppedLogProbeRequest{ID: 2, Operation: "LOG_FIRST"}).Type != "error" || calls != 1 {
				t.Fatal("baselinefailureadmittedmoreHTTP")
			}
		})
	}
}

func TestStoppedLogProbeSequenceAndOriginalTimeCannotRenew(t *testing.T) {
	for _, mode := range []string{"skip", "wrong-id", "unknown", "cancelled", "wall-forward", "wall-backward", "monotonic", "concurrent"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			s, err := initializeStoppedLogProbe(context.Background(), stoppedLogProbeFixture(t), time.Now(), func(context.Context) (doer, error) {
				return logDoerFunc(func(*http.Request) (*http.Response, error) { calls++; return nil, nil }), nil
			})
			if err != nil {
				t.Fatal(err)
			}
			r := stoppedLogProbeRequest{ID: 1, Operation: "BASELINE_BEFORE"}
			ctx := context.Background()
			switch mode {
			case "skip":
				r.Operation = "LOG_FIRST"
			case "wrong-id":
				r.ID = 2
			case "unknown":
				r.Operation = "POST"
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "wall-forward":
				s.now = func() time.Time { return s.cutoff }
			case "wall-backward":
				s.now = func() time.Time { return s.anchor.Add(-time.Millisecond) }
			case "monotonic":
				s.elapsed = func() time.Duration { return s.lifetime }
			case "concurrent":
				s.mu.Lock()
				defer s.mu.Unlock()
			}
			if s.request(ctx, r).Type != "error" || calls != 0 {
				t.Fatal("invalidworkdispatched")
			}
			if !s.failed.Load() {
				t.Fatal("failurewasnotsticky")
			}
		})
	}
}

func TestStoppedLogProbeRequiredZeroAndFalseFieldsCannotBeNull(t *testing.T) {
	for _, key := range []string{"maximumStarts", "maximumStoppedConfigUpdates", "productionReady", "qualificationAllowed", "providerCalls", "emails"} {
		t.Run(key, func(t *testing.T) {
			var raw map[string]json.RawMessage
			json.Unmarshal(stoppedLogProbeFixture(t), &raw)
			var p map[string]interface{}
			json.Unmarshal(raw["probe"], &p)
			p[key] = nil
			probe, _ := json.Marshal(p)
			probe, _ = canonical(probe)
			var a map[string]interface{}
			json.Unmarshal(raw["approval"], &a)
			a["probeDigest"] = hash(probe)
			approval, _ := json.Marshal(a)
			packet, _ := json.Marshal(map[string]json.RawMessage{"probe": probe, "approval": approval})
			calls := 0
			if _, err := initializeStoppedLogProbe(context.Background(), packet, time.Now(), func(context.Context) (doer, error) { calls++; return nil, nil }); err == nil || calls != 0 {
				t.Fatal("nullauthorityaccepted")
			}
		})
	}
}
