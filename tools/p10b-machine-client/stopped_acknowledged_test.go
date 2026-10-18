package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/superfly/fly-go/flaps"
	"github.com/superfly/fly-go/tokens"
)

type acknowledgedHTTP struct {
	t                                         *testing.T
	baseline, candidate                       json.RawMessage
	config                                    json.RawMessage
	version, state                            string
	primaryFailure, restoreFailure, waitReply string
	imageOverride                             string
	waitSeconds                               string
	posts, waits, gets                        int
	cancel                                    context.CancelFunc
	lastBody                                  []byte
	beforeReply                               func(*http.Request)
}

func (f *acknowledgedHTTP) Do(req *http.Request) (*http.Response, error) {
	f.t.Helper()
	if f.beforeReply != nil {
		f.beforeReply(req)
	}
	if req.URL.Scheme != "https" || req.URL.Host != "api.machines.dev" || req.GetBody != nil || req.Header.Get("Idempotency-Key") != "" || req.Header.Get("X-Idempotency-Key") != "" {
		f.t.Fatal("request escaped the frozen native HTTP contract")
	}
	if req.URL.Path == "/v1"+endpoint+"/wait" {
		f.waits++
		seconds := f.waitSeconds
		if seconds == "" {
			seconds = "9"
		}
		if req.Method != "GET" || req.URL.RawQuery != "state=settled&timeout="+seconds+"&version="+f.version {
			f.t.Fatalf("wrong version-bound wait request: %s %s", req.Method, req.URL.String())
		}
		body := f.waitReply
		if body == "" {
			body = `{"ok":true,"state":"created","version":"` + f.version + `","event_id":"private-event-canary"}`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	}
	if req.URL.Path != "/v1"+endpoint || req.URL.RawQuery != "" {
		f.t.Fatal("unexpected Machine endpoint or query")
	}
	if req.Method == "POST" {
		f.posts++
		var body struct {
			Config         json.RawMessage `json:"config"`
			CurrentVersion string          `json:"current_version"`
			SkipLaunch     bool            `json:"skip_launch"`
		}
		raw, err := io.ReadAll(req.Body)
		if err != nil || strict(raw, &body) != nil || !body.SkipLaunch || body.CurrentVersion != f.version {
			f.t.Fatal("unbound stopped update")
		}
		f.lastBody = raw
		f.config = body.Config
		f.version = "ack-version-" + jsonNumber(f.posts)
		f.state = "replacing"
		failure := f.primaryFailure
		if f.posts == 2 {
			failure = f.restoreFailure
		}
		switch failure {
		case "timeout":
			f.state = "stopped"
			f.cancel()
			return nil, req.Context().Err()
		case "loss":
			f.state = "stopped"
			return nil, errors.New("private-transport-canary")
		case "unusable":
			f.state = "stopped"
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"id":"wrong"}`))}, nil
		case "reused-original-version":
			f.version = "original-version"
		}
	} else if req.Method == "GET" {
		f.gets++
	} else {
		f.t.Fatal("unexpected HTTP method")
	}
	image := "sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629"
	c, _ := canonical(f.config)
	want, _ := canonical(f.candidate)
	if string(c) == string(want) {
		image = "sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc"
	}
	if f.imageOverride != "" {
		image = f.imageOverride
	}
	if req.Method == "POST" && f.posts == 1 && f.primaryFailure == "image-drift" {
		image = "sha256:" + strings.Repeat("b", 64)
	}
	b, _ := json.Marshal(map[string]interface{}{"id": "0803730bd1d7e8", "region": "ewr", "state": f.state, "instance_id": f.version, "config": f.config, "image_ref": map[string]string{"digest": image}})
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(b)))}, nil
}

func acknowledgedService(t *testing.T) (*service, *acknowledgedHTTP) {
	t.Helper()
	t.Setenv("FLY_FLAPS_BASE_URL", "https://api.machines.dev")
	b := json.RawMessage(`{"image":"registry.fly.io/uckele-group-p10b@sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629"}`)
	c := json.RawMessage(`{"image":"registry.fly.io/uckele-group-p10b@sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc"}`)
	b, _ = canonical(b)
	c, _ = canonical(c)
	f := &acknowledgedHTTP{t: t, baseline: b, candidate: c, config: b, version: "original-version", state: "stopped"}
	builder, err := flaps.NewWithOptions(context.Background(), flaps.NewClientOpts{Tokens: tokens.Parse("synthetic-ack-test-only")})
	if err != nil {
		t.Fatal(err)
	}
	s := &service{builder: builder, client: f, deadline: time.Now().Add(time.Minute), allowedConfig: map[string]bool{hash(b): true, hash(c): true}}
	enableStoppedDiagnostic(s, b, c, f.version)
	return s, f
}

func acknowledgedPost(config json.RawMessage, version string) json.RawMessage {
	b, _ := json.Marshal(map[string]interface{}{"config": config, "current_version": version, "skip_launch": true})
	return b
}

func TestFailedPrimaryCannotRestoreFromLaterVisibleCandidate(t *testing.T) {
	for _, mode := range []string{"timeout", "loss", "unusable", "image-drift"} {
		t.Run(mode, func(t *testing.T) {
			s, f := acknowledgedService(t)
			if !s.request(context.Background(), request{ID: 1, Method: "GET", TimeoutMs: 1000}).OK {
				t.Fatal("baseline read failed")
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f.primaryFailure, f.cancel = mode, cancel
			out := s.request(ctx, request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)})
			if out.OK {
				t.Fatal("failed primary was acknowledged")
			}
			s.request(context.Background(), request{ID: 3, Method: "GET", TimeoutMs: 1000})
			wait, _ := json.Marshal(map[string]string{"version": f.version})
			if s.request(context.Background(), request{ID: 4, Method: "WAIT", TimeoutMs: 9000, Body: wait}).OK {
				t.Fatal("wait must not authenticate an unacknowledged write")
			}
			s.request(context.Background(), request{ID: 5, Method: "GET", TimeoutMs: 1000})
			out = s.request(context.Background(), request{ID: 6, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)})
			if out.OK || out.Error != "request-denied" || f.posts != 1 {
				t.Fatalf("late visibility authorized restoration after %s: code=%s posts=%d", mode, out.Error, f.posts)
			}
		})
	}
}

func TestCreatedCandidateRestorationRequiresAcknowledgementWaitAndFreshGet(t *testing.T) {
	s, f := acknowledgedService(t)
	wait, _ := json.Marshal(map[string]string{"version": "original-version"})
	if s.request(context.Background(), request{ID: 1, Method: "WAIT", TimeoutMs: 9000, Body: wait}).Error != "request-denied" || f.waits != 0 {
		t.Fatal("wait before acknowledgement reached HTTP")
	}
	s.request(context.Background(), request{ID: 2, Method: "GET", TimeoutMs: 1000})
	if !s.request(context.Background(), request{ID: 3, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)}).OK {
		t.Fatal("valid transient acknowledgement rejected")
	}
	f.state = "created"
	s.request(context.Background(), request{ID: 4, Method: "GET", TimeoutMs: 1000})
	if s.request(context.Background(), request{ID: 5, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).Error != "request-denied" {
		t.Fatal("restoration admitted before wait")
	}
	wait, _ = json.Marshal(map[string]string{"version": f.version})
	out := s.request(context.Background(), request{ID: 6, Method: "WAIT", TimeoutMs: 9000, Body: wait})
	raw, _ := json.Marshal(out)
	if !out.OK || !strings.Contains(string(raw), `"settlement":{"ok":true,"state":"created","version":"ack-version-1"}`) || strings.Contains(string(raw), "private-event-canary") {
		t.Fatalf("closed version-bound settlement missing: %s", raw)
	}
	if s.request(context.Background(), request{ID: 7, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).Error != "request-denied" {
		t.Fatal("restoration admitted without post-wait GET")
	}
	s.request(context.Background(), request{ID: 8, Method: "GET", TimeoutMs: 1000})
	if !s.request(context.Background(), request{ID: 9, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).OK {
		t.Fatal("created candidate could not restore after ack+wait+fresh GET")
	}
	wait, _ = json.Marshal(map[string]string{"version": f.version})
	if !s.request(context.Background(), request{ID: 10, Method: "WAIT", TimeoutMs: 9000, Body: wait}).OK {
		t.Fatal("restoration acknowledgement could not be settled")
	}
	if s.request(context.Background(), request{ID: 11, Method: "WAIT", TimeoutMs: 9000, Body: wait}).Error != "request-denied" {
		t.Fatal("wait replay admitted")
	}
	if s.request(context.Background(), request{ID: 12, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).Error != "request-denied" || f.posts != 2 {
		t.Fatal("third mutation admitted")
	}
}

func acknowledgeAndSettlePrimary(t *testing.T, s *service, f *acknowledgedHTTP) {
	t.Helper()
	if !s.request(context.Background(), request{ID: 1, Method: "GET", TimeoutMs: 1000}).OK || !s.request(context.Background(), request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)}).OK {
		t.Fatal("primary acknowledgement failed")
	}
	if !s.request(context.Background(), request{ID: 3, Method: "WAIT", TimeoutMs: 9000, Body: json.RawMessage(`{"version":"` + f.version + `"}`)}).OK {
		t.Fatal("primary settlement failed")
	}
	f.state = "created"
}

func TestPostAcknowledgementGetDriftPermanentlyHoldsRestoration(t *testing.T) {
	for _, mode := range []string{"running", "version", "config", "image"} {
		t.Run(mode, func(t *testing.T) {
			s, f := acknowledgedService(t)
			acknowledgeAndSettlePrimary(t, s, f)
			switch mode {
			case "running":
				f.state = "started"
			case "version":
				f.version = "different-version"
			case "config":
				f.config = f.baseline
			case "image":
				f.imageOverride = "sha256:" + strings.Repeat("b", 64)
			}
			if s.request(context.Background(), request{ID: 4, Method: "GET", TimeoutMs: 1000}).OK {
				t.Fatal("drifting post-acknowledgement GET was accepted")
			}
			f.state, f.version, f.config, f.imageOverride = "created", "ack-version-1", f.candidate, ""
			s.request(context.Background(), request{ID: 5, Method: "GET", TimeoutMs: 1000})
			if s.request(context.Background(), request{ID: 6, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).Error != "request-denied" || f.posts != 1 {
				t.Fatal("later matching GET cleared the permanent hold")
			}
		})
	}
}

func TestFailedOrMismatchedSettlementCannotRegainRestoration(t *testing.T) {
	for _, mode := range []string{"not-ok", "wrong-version", "running", "replacing", "missing-version", "unknown-field", "duplicate-ok", "wrong-request-version", "extra-request-field"} {
		t.Run(mode, func(t *testing.T) {
			s, f := acknowledgedService(t)
			s.request(context.Background(), request{ID: 1, Method: "GET", TimeoutMs: 1000})
			if !s.request(context.Background(), request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)}).OK {
				t.Fatal("primary acknowledgement failed")
			}
			f.waitReply = `{"ok":true,"state":"created","version":"` + f.version + `"}`
			body := json.RawMessage(`{"version":"` + f.version + `"}`)
			switch mode {
			case "not-ok":
				f.waitReply = strings.Replace(f.waitReply, `true`, `false`, 1)
			case "wrong-version":
				f.waitReply = strings.Replace(f.waitReply, f.version, "wrong", 1)
			case "running", "replacing":
				f.waitReply = strings.Replace(f.waitReply, "created", mode, 1)
			case "missing-version":
				f.waitReply = `{"ok":true,"state":"created"}`
			case "unknown-field":
				f.waitReply = strings.TrimSuffix(f.waitReply, "}") + `,"headers":"private-canary"}`
			case "duplicate-ok":
				f.waitReply = strings.Replace(f.waitReply, `"ok":true`, `"ok":false,"ok":true`, 1)
			case "wrong-request-version":
				body = json.RawMessage(`{"version":"wrong"}`)
			case "extra-request-field":
				body = json.RawMessage(`{"version":"` + f.version + `","state":"stopped"}`)
			}
			out := s.request(context.Background(), request{ID: 3, Method: "WAIT", TimeoutMs: 9000, Body: body})
			if out.OK || !s.diagnostic.hold {
				t.Fatal("failed settlement did not latch a hold")
			}
			f.state = "created"
			s.request(context.Background(), request{ID: 4, Method: "GET", TimeoutMs: 1000})
			if s.request(context.Background(), request{ID: 5, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).Error != "request-denied" || f.posts != 1 {
				t.Fatal("later candidate visibility authorized restoration")
			}
			waits := f.waits
			if s.request(context.Background(), request{ID: 6, Method: "WAIT", TimeoutMs: 9000, Body: json.RawMessage(`{"version":"` + f.version + `"}`)}).Error != "request-denied" || f.waits != waits {
				t.Fatal("failed wait was retried")
			}
		})
	}
}

func TestUncertainRestorationNeverRetriesOrSettlesFromVisibility(t *testing.T) {
	for _, mode := range []string{"timeout", "loss", "unusable", "reused-original-version"} {
		t.Run(mode, func(t *testing.T) {
			s, f := acknowledgedService(t)
			acknowledgeAndSettlePrimary(t, s, f)
			s.request(context.Background(), request{ID: 4, Method: "GET", TimeoutMs: 1000})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f.restoreFailure, f.cancel = mode, cancel
			if s.request(ctx, request{ID: 5, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).OK {
				t.Fatal("uncertain restoration was acknowledged")
			}
			s.request(context.Background(), request{ID: 6, Method: "GET", TimeoutMs: 1000})
			if s.request(context.Background(), request{ID: 7, Method: "WAIT", TimeoutMs: 9000, Body: json.RawMessage(`{"version":"` + f.version + `"}`)}).Error != "request-denied" {
				t.Fatal("unacknowledged restoration was settled from visibility")
			}
			if s.request(context.Background(), request{ID: 8, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}).Error != "request-denied" || f.posts != 2 {
				t.Fatal("restoration retry reached HTTP")
			}
		})
	}
}

func TestWaitTimeoutWireFloorAndBounds(t *testing.T) {
	for _, timeout := range []int{999, 1000, 1999, 9000, 9001} {
		t.Run(strconv.Itoa(timeout), func(t *testing.T) {
			s, f := acknowledgedService(t)
			s.request(context.Background(), request{ID: 1, Method: "GET", TimeoutMs: 1000})
			s.request(context.Background(), request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)})
			f.waitSeconds = strconv.Itoa(timeout / 1000)
			out := s.request(context.Background(), request{ID: 3, Method: "WAIT", TimeoutMs: timeout, Body: json.RawMessage(`{"version":"` + f.version + `"}`)})
			if timeout >= 1000 && timeout <= 9000 {
				if !out.OK || f.waits != 1 {
					t.Fatal("bounded wait failed")
				}
			} else if out.Error != "request-denied" || f.waits != 0 {
				t.Fatal("unbounded wait reached HTTP")
			}
		})
	}
}

func TestDiagnosticDuplicateTopLevelPostFieldsNeverReachHTTP(t *testing.T) {
	for _, key := range []string{"config", "current_version", "skip_launch"} {
		t.Run(key, func(t *testing.T) {
			s, f := acknowledgedService(t)
			s.request(context.Background(), request{ID: 1, Method: "GET", TimeoutMs: 1000})
			body := string(acknowledgedPost(f.candidate, f.version))
			switch key {
			case "config":
				body = `{"config":` + string(f.baseline) + `,` + strings.TrimPrefix(body, "{")
			case "current_version":
				body = `{"current_version":"different-version",` + strings.TrimPrefix(body, "{")
			case "skip_launch":
				body = `{"skip_launch":false,` + strings.TrimPrefix(body, "{")
			}
			out := s.request(context.Background(), request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: json.RawMessage(body)})
			if out.Error != "request-denied" || f.posts != 0 {
				t.Fatal("ambiguous duplicate POST fields reached HTTP")
			}
		})
	}
}

func TestDiagnosticPostSendsOnlyCanonicalValidatedNestedConfig(t *testing.T) {
	s, f := acknowledgedService(t)
	s.request(context.Background(), request{ID: 1, Method: "GET", TimeoutMs: 1000})
	config := json.RawMessage(`{"image":"registry.fly.io/uckele-group-p10b@sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629",` + strings.TrimPrefix(string(f.candidate), "{"))
	out := s.request(context.Background(), request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(config, f.version)})
	if !out.OK || strings.Count(string(f.lastBody), `"image"`) != 1 {
		t.Fatal("wire config differed from the canonical validated object")
	}
}

func TestNativeSharedObservationWindowExpiresWithoutRenewal(t *testing.T) {
	s, f := acknowledgedService(t)
	acknowledgeAndSettlePrimary(t, s, f)
	began := time.Now()
	// This real delay protects the policy across IPC calls, independently of
	// the host clock and of the one-second freshness of an individual GET.
	time.Sleep(10050 * time.Millisecond)
	get := s.request(context.Background(), request{ID: 4, Method: "GET", TimeoutMs: 1000})
	restore := s.request(context.Background(), request{ID: 5, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)})
	t.Logf("elapsedMs=%d lateReadOK=%t restoreOK=%t totalPosts=%d", time.Since(began).Milliseconds(), get.OK, restore.OK, f.posts)
	if get.OK || restore.OK || f.posts != 1 || !s.diagnostic.hold {
		t.Fatal("expired shared observation window regained restoration authority")
	}
}

type deadlineBuilder struct {
	requestBuilder
	afterBuild func()
}

func (b deadlineBuilder) NewRequest(ctx context.Context, method, path string, in interface{}, headers map[string][]string) (*http.Request, error) {
	r, err := b.requestBuilder.NewRequest(ctx, method, path, in, headers)
	if b.afterBuild != nil {
		b.afterBuild()
	}
	return r, err
}

func TestNativeSharedWindowCannotExpireDuringAdmissionOrResponse(t *testing.T) {
	for _, boundary := range []string{"restore-before-build", "restore-after-build", "get-after-build", "get-response", "wait-response"} {
		t.Run(boundary, func(t *testing.T) {
			s, f := acknowledgedService(t)
			acknowledgeAndSettlePrimary(t, s, f)
			deadline := s.diagnostic.phaseDeadline
			if !s.request(context.Background(), request{ID: 4, Method: "GET", TimeoutMs: 1000}).OK {
				t.Fatal("fresh candidate read failed")
			}
			if !deadline.Equal(s.diagnostic.phaseDeadline) {
				t.Fatal("fresh GET renewed the phase window")
			}
			expire := func() { s.diagnostic.phaseDeadline = time.Now().Add(-time.Millisecond) }
			req := request{ID: 5, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.baseline, f.version)}
			switch boundary {
			case "restore-before-build":
				expire()
			case "restore-after-build":
				s.builder = deadlineBuilder{requestBuilder: s.builder, afterBuild: expire}
			case "get-after-build":
				s.builder = deadlineBuilder{requestBuilder: s.builder, afterBuild: expire}
				req = request{ID: 5, Method: "GET", TimeoutMs: 1000}
			case "get-response":
				f.beforeReply = func(*http.Request) { expire() }
				req = request{ID: 5, Method: "GET", TimeoutMs: 1000}
			case "wait-response":
				// A new service reaches its first WAIT, whose otherwise valid
				// response arrives only after the immutable window closes.
				s, f = acknowledgedService(t)
				s.request(context.Background(), request{ID: 1, Method: "GET", TimeoutMs: 1000})
				s.request(context.Background(), request{ID: 2, Method: "POST", TimeoutMs: 10000, Body: acknowledgedPost(f.candidate, f.version)})
				f.beforeReply = func(*http.Request) { expire() }
				req = request{ID: 3, Method: "WAIT", TimeoutMs: 9000, Body: json.RawMessage(`{"version":"` + f.version + `"}`)}
			}
			out := s.request(context.Background(), req)
			if out.OK || f.posts != 1 {
				t.Fatal("late admission or response regained write authority")
			}
			if boundary != "restore-before-build" && !s.diagnostic.hold {
				t.Fatal("uncertain late phase did not latch a hold")
			}
			if boundary == "restore-after-build" && (out.Observation == nil || out.Observation.Dispatched) {
				t.Fatal("expired restoration was dispatched after SDK admission")
			}
		})
	}
}
