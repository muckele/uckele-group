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
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type logDoerFunc func(*http.Request) (*http.Response, error)

func (f logDoerFunc) Do(r *http.Request) (*http.Response, error) { return f(r) }

func TestLogReaderErrorEnvelopeCannotBecomeHealthyEmpty(t *testing.T) {
	for _, key := range []string{"error", "errors"} {
		for _, value := range []string{`null`, `false`, `[]`, `{}`, `"private-canary"`} {
			t.Run(key+"-"+value, func(t *testing.T) {
				calls := 0
				s, err := initializeLogs(logInitializationFixture(t), func(context.Context) (doer, error) {
					return logDoerFunc(func(*http.Request) (*http.Response, error) {
						calls++
						return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[],"` + key + `":` + value + `}`))}, nil
					}), nil
				})
				if err != nil {
					t.Fatal(err)
				}
				out := s.request(context.Background(), logRequest{ID: 1, Method: "GET", TimeoutMs: 700})
				raw, _ := json.Marshal(out)
				if out.OK || out.Error != "invalid-output" || out.Observation.HTTPStatus == nil || *out.Observation.HTTPStatus != 200 || strings.Contains(string(raw), "private") {
					t.Fatalf("error envelope accepted or exposed: ok=%t error=%s", out.OK, out.Error)
				}
				if s.request(context.Background(), logRequest{ID: 2, Method: "GET", TimeoutMs: 700}).OK || calls != 1 {
					t.Fatal("error envelope admitted retry")
				}
			})
		}
	}
}

func logInitializationFixture(t *testing.T) []byte {
	s, p := guardianInitializationFixture(t)
	raw, _ := json.Marshal(s)
	p.Version = "p10b-native-log-init-v1"
	p.ReadOnly = true
	p.Configs = p.Configs[1:]
	p.SessionCanonical = string(raw)
	p.SessionDigest = hash(raw)
	raw, _ = json.Marshal(logInitPacket{Version: p.Version, Approved: p.Approved, ReadOnly: p.ReadOnly, SessionCanonical: p.SessionCanonical, SessionDigest: p.SessionDigest, Configs: p.Configs})
	return raw
}

func TestLogReaderRestrictedHTTPTransportAgainstLocalTLS(t *testing.T) {
	for _, mode := range []string{"empty", "503", "redirect", "reset", "slow-header", "slow-body"} {
		t.Run(mode, func(t *testing.T) {
			var calls int32
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&calls, 1)
				if r.Host != "api.fly.io" || r.URL.RequestURI() != "/api/v1/apps/uckele-group-p10b/logs?instance=0803730bd1d7e8&next_token=" || r.Method != "GET" || r.ProtoMajor != 1 || r.Header.Get("Accept-Encoding") != "" || r.Header.Get("Authorization") == "" {
					t.Error("HTTPboundary widened")
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
				case "slow-header":
					<-r.Context().Done()
					return
				case "slow-body":
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
					<-r.Context().Done()
					return
				}
				io.WriteString(w, `{"data":[],"meta":{"next_token":"private-cursor"}}`)
			}))
			server.EnableHTTP2 = true
			server.StartTLS()
			defer server.Close()
			transport := restrictedLogTransport()
			defer transport.CloseIdleConnections()
			if transport.Proxy != nil || !transport.DisableKeepAlives || !transport.DisableCompression || transport.ForceAttemptHTTP2 || len(transport.TLSNextProto) != 0 || len(transport.TLSClientConfig.NextProtos) != 1 || transport.TLSClientConfig.NextProtos[0] != "http/1.1" {
				t.Fatal("restrictedtransportconfiguration")
			}
			pool := x509.NewCertPool()
			pool.AddCert(server.Certificate())
			transport.TLSClientConfig.RootCAs = pool
			transport.TLSClientConfig.ServerName = "example.com"
			address, _ := url.Parse(server.URL)
			transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
				if addr != "api.fly.io:443" {
					return nil, errors.New("unexpecteddialtarget")
				}
				return (&net.Dialer{}).DialContext(ctx, "tcp", address.Host)
			}
			client, e := newLogHTTP("synthetic-private-canary", transport)
			if e != nil {
				t.Fatal(e)
			}
			s, e := initializeLogs(logInitializationFixture(t), func(context.Context) (doer, error) { return client, nil })
			if e != nil {
				t.Fatal(e)
			}
			out := s.request(context.Background(), logRequest{ID: 1, Method: "GET", TimeoutMs: 150})
			raw, _ := json.Marshal(out)
			if calls != 1 || out.OK != (mode == "empty") || strings.Contains(string(raw), "private") {
				t.Fatalf("HTTPmode=%s count=%d ok=%t error=%s", mode, calls, out.OK, out.Error)
			}
		})
	}
}

func TestLogReaderInputEOFCancelsActiveRequest(t *testing.T) {
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	started := make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		defer output.Close()
		finished <- serveLogs(input, output, func(context.Context) (doer, error) {
			return logDoerFunc(func(r *http.Request) (*http.Response, error) {
				close(started)
				<-r.Context().Done()
				return nil, r.Context().Err()
			}), nil
		})
	}()
	go func() { writer.Write(append(logInitializationFixture(t), '\n')) }()
	decoder := json.NewDecoder(reader)
	var ready map[string]interface{}
	if decoder.Decode(&ready) != nil || ready["ready"] != true {
		t.Fatal("readyabsent")
	}
	go func() { io.WriteString(writer, "{\"id\":1,\"method\":\"GET\",\"timeoutMs\":5000}\n") }()
	<-started
	writer.Close()
	var failure logResponse
	if decoder.Decode(&failure) != nil || failure.OK || failure.Error != "timed-out" {
		t.Fatal("EOFdidnotcancel")
	}
	select {
	case e := <-finished:
		if e == nil {
			t.Fatal("EOFactivefailureaccepted")
		}
	case <-time.After(time.Second):
		t.Fatal("EOFcleanupnotbounded")
	}
}

func guardianLogFixture(t *testing.T, s *logService, timestamp string) map[string]interface{} {
	t.Helper()
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	event := map[string]interface{}{"version": "p10b-guardian-child-exit-v1", "windowDigest": s.windowDigest, "bindingVerified": true, "code": 0, "signal": nil, "spawnFailed": false, "guardianPid": 123, "parentPid": 124, "exitedAt": now, "parentStartedAt": now, "readyDigest": strings.Repeat("a", 64), "receiptDigest": strings.Repeat("b", 64), "startDigest": strings.Repeat("c", 64), "productionReady": false}
	raw, _ := json.Marshal(event)
	return map[string]interface{}{"id": "private-id", "attributes": map[string]interface{}{"timestamp": timestamp, "message": guardianExitPrefix + string(raw), "instance": "0803730bd1d7e8", "region": "ewr", "private": "private-canary"}}
}
func TestLogReaderProjectsOnlyBoundGuardianAndPreservesNanoseconds(t *testing.T) {
	s, err := initializeLogs(logInitializationFixture(t), func(context.Context) (doer, error) {
		return logDoerFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("unused") }), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	stamp := "2026-10-17T20:00:00.123456789Z"
	valid := guardianLogFixture(t, s, stamp)
	for _, mode := range []string{"valid", "app", "wrong-machine", "wrong-region", "wrong-window", "unknown-event", "duplicate-event", "invalid-time", "two-distinct-nanoseconds", "too-many"} {
		t.Run(mode, func(t *testing.T) {
			copyRaw, _ := json.Marshal(valid)
			var row map[string]interface{}
			json.Unmarshal(copyRaw, &row)
			a := row["attributes"].(map[string]interface{})
			records := []interface{}{row}
			want := 0
			switch mode {
			case "valid":
				want = 1
			case "app":
				a["message"] = "private-canary"
			case "wrong-machine":
				a["instance"] = "other"
			case "wrong-region":
				a["region"] = "ord"
			case "wrong-window":
				a["message"] = strings.Replace(a["message"].(string), s.windowDigest, strings.Repeat("0", 64), 1)
			case "unknown-event":
				a["message"] = strings.Replace(a["message"].(string), `{"`, `{"private":"private-canary","`, 1)
			case "duplicate-event":
				a["message"] = strings.Replace(a["message"].(string), `{"`, `{"code":0,"`, 1)
			case "invalid-time":
				a["timestamp"] = "2026-02-31T00:00:00Z"
			case "two-distinct-nanoseconds":
				want = 2
				records = append(records, guardianLogFixture(t, s, "2026-10-17T20:00:00.123456788Z"))
			case "too-many":
				for len(records) < 129 {
					records = append(records, valid)
				}
			}
			raw, _ := json.Marshal(map[string]interface{}{"data": records, "meta": map[string]string{"next_token": "private-cursor"}})
			got, err := projectLogBody(raw, s.windowDigest)
			if mode == "too-many" {
				if err == nil {
					t.Fatal("recordboundadmitted")
				}
				return
			}
			if err != nil || len(got) != want {
				t.Fatalf("projection mode=%s count=%d err=%v", mode, len(got), err)
			}
			b, _ := json.Marshal(got)
			if strings.Contains(string(b), "private") {
				t.Fatal("privateprojection")
			}
			if want > 0 && got[0].Timestamp != stamp {
				t.Fatal("timestamp precisionlost")
			}
		})
	}
}
func TestLogReaderAttemptAndDeadlineAuthority(t *testing.T) {
	for _, mode := range []string{"post", "wait", "timeout-too-long", "zero", "replayed-id", "quota", "wall-forward", "wall-backward-monotonic", "cancelled", "late-body"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			s, err := initializeLogs(logInitializationFixture(t), func(context.Context) (doer, error) {
				return logDoerFunc(func(*http.Request) (*http.Response, error) {
					calls++
					if mode == "late-body" {
						time.Sleep(15 * time.Millisecond)
					}
					return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[]}`))}, nil
				}), nil
			})
			if err != nil {
				t.Fatal(err)
			}
			r := logRequest{ID: 1, Method: "GET", TimeoutMs: 10}
			ctx := context.Background()
			switch mode {
			case "post":
				r.Method = "POST"
			case "wait":
				r.Method = "WAIT"
			case "timeout-too-long":
				s.attempts = 1
				r.TimeoutMs = 701
			case "zero":
				r.TimeoutMs = 0
			case "replayed-id":
				s.previous = 1
			case "quota":
				s.attempts = 410
			case "wall-forward":
				s.now = func() time.Time { return s.deadline }
			case "wall-backward-monotonic":
				s.now = func() time.Time { return time.Now().Add(-time.Hour) }
				s.elapsed = func() time.Duration { return s.lifetime }
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			out := s.request(ctx, r)
			if out.OK {
				t.Fatal("authorityadmitted")
			}
			want := 0
			if mode == "late-body" {
				want = 1
			}
			if calls != want {
				t.Fatalf("calls=%d expected=%d", calls, want)
			}
		})
	}
	// 410 includes successful empty observations; operation 411 is never sent.
	var calls int32
	s, err := initializeLogs(logInitializationFixture(t), func(context.Context) (doer, error) {
		return logDoerFunc(func(*http.Request) (*http.Response, error) {
			atomic.AddInt32(&calls, 1)
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[]}`))}, nil
		}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for id := 1; id <= 410; id++ {
		if !s.request(context.Background(), logRequest{ID: id, Method: "GET", TimeoutMs: 700}).OK {
			t.Fatalf("earlyquota%d", id)
		}
	}
	if s.request(context.Background(), logRequest{ID: 411, Method: "GET", TimeoutMs: 700}).OK || calls != 410 {
		t.Fatal("quota exceeded")
	}
}

type logRoundTripper func(*http.Request) (*http.Response, error)

func (f logRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestLogReaderSDKDoesNotRetryOrExposeOpaqueAuthentication(t *testing.T) {
	for _, mode := range []string{"503", "reset", "redirect", "empty"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			client, err := newLogHTTP("synthetic-private-canary", logRoundTripper(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.String() != logEndpoint || r.Header.Get("Authorization") == "" {
					t.Fatal("SDKboundary")
				}
				if mode == "reset" {
					return nil, errors.New("synthetic-private-canary")
				}
				status := 503
				if mode == "redirect" {
					status = 302
				}
				if mode == "empty" {
					status = 200
				}
				h := make(http.Header)
				h.Set("Location", "https://private.invalid")
				return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(`{"data":[]}`)), Request: r}, nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			s, err := initializeLogs(logInitializationFixture(t), func(context.Context) (doer, error) { return client, nil })
			if err != nil {
				t.Fatal(err)
			}
			out := s.request(context.Background(), logRequest{ID: 1, Method: "GET", TimeoutMs: 700})
			b, _ := json.Marshal(out)
			if calls != 1 || out.OK != (mode == "empty") || strings.Contains(string(b), "canary") {
				t.Fatalf("mode=%s count=%d ok=%t", mode, calls, out.OK)
			}
		})
	}
}

func TestLogReaderEmptyIsOneCompletedRequest(t *testing.T) {
	calls := 0
	s, err := initializeLogs(logInitializationFixture(t), func(context.Context) (doer, error) {
		return logDoerFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			if r.Method != "GET" || r.URL.String() != logEndpoint || r.Body != nil || r.GetBody != nil {
				t.Fatal("request widened")
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[],"meta":{"next_token":"private-cursor"}}`))}, nil
		}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	r := s.request(context.Background(), logRequest{ID: 1, Method: "GET", TimeoutMs: 700})
	encoded, _ := json.Marshal(r)
	if !r.OK || r.Logs == nil || len(r.Logs) != 0 || calls != 1 || strings.Contains(string(encoded), "private") {
		t.Fatalf("empty completion: %s calls=%d", encoded, calls)
	}
}

func TestLogReaderFailuresAreTerminalAndPublic(t *testing.T) {
	for _, mode := range []string{"401", "503", "redirect", "transport", "truncated", "oversize", "trailing", "duplicate", "null-data", "missing-data", "malformed-row", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			s, err := initializeLogs(logInitializationFixture(t), func(context.Context) (doer, error) {
				return logDoerFunc(func(r *http.Request) (*http.Response, error) {
					calls++
					status := 200
					body := `{"data":[],"meta":{}}`
					switch mode {
					case "401":
						status = 401
						body = "private-token"
					case "503":
						status = 503
						body = "private-token"
					case "redirect":
						status = 302
						body = "private-token"
					case "transport":
						return nil, errors.New("private-token")
					case "truncated":
						body = `{"data":[`
					case "oversize":
						body = strings.Repeat("x", 131073)
					case "trailing":
						body += `{}`
					case "duplicate":
						body = `{"data":[],"data":[],"meta":{}}`
					case "null-data":
						body = `{"data":null,"meta":{}}`
					case "missing-data":
						body = `{"meta":{}}`
					case "malformed-row":
						body = `{"data":[{"attributes":null}],"meta":{}}`
					case "timeout":
						<-r.Context().Done()
						return nil, r.Context().Err()
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
				}), nil
			})
			if err != nil {
				t.Fatal(err)
			}
			r := s.request(context.Background(), logRequest{ID: 1, Method: "GET", TimeoutMs: 10})
			b, _ := json.Marshal(r)
			if r.OK || calls != 1 || strings.Contains(string(b), "private") || r.Observation == nil || !r.Observation.Dispatched {
				t.Fatalf("failed response %s calls=%d", b, calls)
			}
			if s.request(context.Background(), logRequest{ID: 2, Method: "GET", TimeoutMs: 10}).OK || calls != 1 {
				t.Fatal("failed transport admitted retry")
			}
		})
	}
}

func TestLogReaderDeniedAuthorityNeverLoadsAuthentication(t *testing.T) {
	for _, mode := range []string{"version", "readonly", "approval", "session", "config", "baseline", "extra", "recoveryVerified", "duplicate", "future", "expired"} {
		t.Run(mode, func(t *testing.T) {
			raw := logInitializationFixture(t)
			var p map[string]interface{}
			json.Unmarshal(raw, &p)
			switch mode {
			case "version":
				p["version"] = "p10b-native-init-v1"
			case "readonly":
				p["readOnly"] = false
			case "approval":
				p["approved"] = false
			case "session":
				p["sessionDigest"] = strings.Repeat("0", 64)
			case "config":
				p["configs"] = []interface{}{}
			case "baseline":
				var s map[string]interface{}
				json.Unmarshal([]byte(p["sessionCanonical"].(string)), &s)
				p["configs"] = []interface{}{s["baselineConfig"]}
			case "extra":
				p["url"] = "https://private.invalid"
			case "recoveryVerified":
				p["recoveryVerified"] = false
			case "future", "expired":
				var s map[string]interface{}
				json.Unmarshal([]byte(p["sessionCanonical"].(string)), &s)
				start := time.Now().Add(time.Hour)
				if mode == "expired" {
					start = time.Now().Add(-2 * time.Hour)
				}
				s["startedAt"] = start.UTC().Format(time.RFC3339Nano)
				s["sessionDeadline"] = start.Add(time.Hour).UTC().Format(time.RFC3339Nano)
				b, _ := json.Marshal(s)
				p["sessionCanonical"] = string(b)
				p["sessionDigest"] = hash(b)
			}
			raw, _ = json.Marshal(p)
			if mode == "duplicate" {
				raw = append([]byte(`{"approved":true,`), raw[1:]...)
			}
			calls := 0
			_, err := initializeLogs(raw, func(context.Context) (doer, error) { calls++; return nil, nil })
			if err == nil || calls != 0 {
				t.Fatalf("authority mode=%s authcalls=%d error=%v", mode, calls, err)
			}
		})
	}
}
