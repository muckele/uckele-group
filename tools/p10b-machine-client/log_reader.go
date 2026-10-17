package main

// Log mode deliberately bypasses the CLI's empty-result polling and retry
// client. Admission is pure; only the fixed read-only HTTP boundary receives
// opaque inherited authentication. No app data or provider cursor crosses IPC.
import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	fly "github.com/superfly/fly-go"
	"github.com/superfly/fly-go/tokens"
)

const logEndpoint = "https://api.fly.io/api/v1/apps/uckele-group-p10b/logs?instance=0803730bd1d7e8&next_token="
const guardianExitPrefix = "P10B_GUARDIAN_CHILD_EXIT "

type logRequest struct {
	ID        int    `json:"id"`
	Method    string `json:"method"`
	TimeoutMs int    `json:"timeoutMs"`
}
type logInitPacket struct {
	Version          string            `json:"version"`
	Approved         bool              `json:"approved"`
	ReadOnly         bool              `json:"readOnly"`
	SessionCanonical string            `json:"sessionCanonical"`
	SessionDigest    string            `json:"sessionDigest"`
	Configs          []json.RawMessage `json:"configs"`
}
type publicLog struct {
	Timestamp string `json:"timestamp"`
	Message   string `json:"message"`
	Instance  string `json:"instance"`
	Region    string `json:"region"`
}
type logResponse struct {
	Version     string              `json:"version"`
	ID          int                 `json:"id"`
	OK          bool                `json:"ok"`
	Error       string              `json:"error,omitempty"`
	Logs        []publicLog         `json:"logs,omitempty"`
	Observation *requestObservation `json:"observation"`
}

// Empty success must contain [] rather than omit/null; failure never carries
// partially admitted log records.
func (r logResponse) MarshalJSON() ([]byte, error) {
	m := map[string]interface{}{"version": r.Version, "id": r.ID, "ok": r.OK, "observation": r.Observation}
	if r.OK {
		m["logs"] = r.Logs
	} else {
		m["error"] = r.Error
	}
	return json.Marshal(m)
}

type logService struct {
	client       doer
	deadline     time.Time
	windowDigest string
	attempts     int
	previous     int
	failed       bool
	now          func() time.Time
	elapsed      func() time.Duration
	lifetime     time.Duration
}

func initializeLogs(raw []byte, factory func(context.Context) (doer, error)) (*logService, error) {
	anchor := time.Now()
	var p logInitPacket
	if !uniqueLogJSON(raw) || strict(raw, &p) != nil || p.Version != "p10b-native-log-init-v1" || !p.ReadOnly || len(p.Configs) != 1 {
		return nil, errors.New("log initialization denied")
	}
	if !uniqueLogJSON([]byte(p.SessionCanonical)) || !uniqueLogJSON(p.Configs[0]) {
		return nil, errors.New("log initialization denied")
	}
	validation, _ := json.Marshal(initPacket{Version: "p10b-native-init-v1", Approved: p.Approved, ReadOnly: true, SessionCanonical: p.SessionCanonical, SessionDigest: p.SessionDigest, Configs: p.Configs})
	// The existing admission's factory is a pure no-op. Never enter loadClient.
	validated, err := initialize(validation, func(context.Context) (requestBuilder, error) { return nil, nil })
	if err != nil {
		return nil, errors.New("log initialization denied")
	}
	var config struct {
		Env map[string]string `json:"env"`
	}
	if json.Unmarshal(p.Configs[0], &config) != nil {
		return nil, errors.New("log initialization denied")
	}
	windowRaw := []byte(config.Env["P10B_GUEST_WINDOW"])
	var window struct {
		Issued string `json:"issuedAt"`
		Stop   string `json:"stopAt"`
	}
	if !uniqueLogJSON(windowRaw) || json.Unmarshal(windowRaw, &window) != nil {
		return nil, errors.New("log initialization denied")
	}
	issued, e1 := time.Parse(time.RFC3339Nano, window.Issued)
	stop, e2 := time.Parse(time.RFC3339Nano, window.Stop)
	now := anchor
	end := stop.Add(750 * time.Millisecond)
	if validated.deadline.Before(end) {
		end = validated.deadline
	}
	if e1 != nil || e2 != nil || now.Before(issued) || !now.Before(end) {
		return nil, errors.New("log initialization denied")
	}
	w, e := canonical(windowRaw)
	if e != nil {
		return nil, errors.New("log initialization denied")
	}
	began := anchor
	life := end.Sub(now)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := factory(ctx)
	if err != nil || client == nil {
		return nil, errors.New("log authentication unavailable")
	}
	s := &logService{client: client, deadline: end, windowDigest: hash(w), now: time.Now, elapsed: func() time.Duration { return time.Since(began) }, lifetime: life}
	if s.remaining() <= 0 {
		return nil, errors.New("log initialization denied")
	}
	return s, nil
}
func (s *logService) remaining() time.Duration {
	wall := s.deadline.Sub(s.now())
	mono := s.lifetime - s.elapsed()
	if mono < wall {
		return mono
	}
	return wall
}

type logSDKDoer struct {
	client *http.Client
	opaque *tokens.Tokens
}

func (c *logSDKDoer) Do(r *http.Request) (*http.Response, error) {
	return c.client.Do(r.WithContext(fly.WithAuthorizationHeader(r.Context(), c.opaque.BubblegumHeader())))
}
func newLogHTTP(token string, transport http.RoundTripper) (doer, error) {
	if token == "" || len(token) > 32768 || strings.ContainsAny(token, "\r\n\x00") {
		return nil, errors.New("log authentication unavailable")
	}
	opaque := tokens.Parse(token)
	return &logSDKDoer{opaque: opaque, client: &http.Client{Transport: &fly.Transport{Tokens: opaque, UserAgent: "p10b-native-log-reader-v1", UnderlyingTransport: transport}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func restrictedLogTransport() *http.Transport {
	return &http.Transport{Proxy: nil, DisableKeepAlives: true, DisableCompression: true, ForceAttemptHTTP2: false, MaxResponseHeaderBytes: 16384, TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{}, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}}}
}
func loadLogHTTP(context.Context) (doer, error) {
	// This reads only the inherited scoped opaque context, never normal Fly
	// configuration, refresh/discharge services, logger, metrics or env defaults.
	if os.Getenv("P10B_APP_TOKEN_CONTEXT") != "p10b-app-token-context-v1" {
		return nil, errors.New("log authentication unavailable")
	}
	return newLogHTTP(os.Getenv("FLY_API_TOKEN"), restrictedLogTransport())
}
func (s *logService) request(ctx context.Context, r logRequest) (out logResponse) {
	started := time.Now()
	out = logResponse{Version: "p10b-native-log-response-v1", ID: r.ID, Error: "request-denied", Observation: &requestObservation{}}
	defer func() {
		out.Observation.ElapsedMs = time.Since(started).Milliseconds()
		if !out.OK {
			s.failed = true
		}
	}()
	maximum := 700
	if s.attempts == 0 {
		maximum = 5000
	}
	if s.failed || r.ID <= s.previous || r.ID < 1 || r.Method != "GET" || r.TimeoutMs < 1 || r.TimeoutMs > maximum || s.attempts >= 410 || s.remaining() <= 0 || ctx.Err() != nil {
		return
	}
	s.previous = r.ID
	s.attempts++
	budget := time.Duration(r.TimeoutMs) * time.Millisecond
	if left := s.remaining(); left < budget {
		budget = left
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", logEndpoint, nil)
	if err != nil {
		out.Error = "request-failed"
		return
	}
	req.Close = true
	req.GetBody = nil
	out.Observation.Dispatched = true
	response, err := s.client.Do(req)
	if response != nil && response.StatusCode >= 100 && response.StatusCode <= 599 {
		status := response.StatusCode
		out.Observation.HTTPStatus = &status
	}
	if err != nil {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		out.Error = "request-failed"
		if ctx.Err() != nil {
			out.Error = "timed-out"
		}
		return
	}
	if response == nil || response.Body == nil {
		out.Error = "invalid-output"
		return
	}
	closed := false
	defer func() {
		if !closed {
			response.Body.Close()
		}
	}()
	status := response.StatusCode
	if status < 100 || status > 599 {
		out.Error = "invalid-output"
		return
	}
	if status != 200 {
		out.Error = "http-failed"
		return
	}
	if response.Header.Get("Content-Encoding") != "" {
		out.Error = "invalid-output"
		return
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 131073))
	closeErr := response.Body.Close()
	closed = true
	if len(raw) > 131072 {
		out.Error = "output-bound"
		return
	}
	if err != nil || closeErr != nil {
		out.Error = "request-failed"
		if ctx.Err() != nil {
			out.Error = "timed-out"
		}
		return
	}
	if ctx.Err() != nil || time.Since(started) >= budget || s.remaining() <= 0 {
		out.Error = "timed-out"
		return
	}
	logs, err := projectLogBody(raw, s.windowDigest)
	if err != nil {
		out.Error = "invalid-output"
		return
	}
	if ctx.Err() != nil || time.Since(started) >= budget || s.remaining() <= 0 {
		out.Error = "timed-out"
		return
	}
	out.OK = true
	out.Error = ""
	out.Logs = logs
	encoded, err := json.Marshal(out)
	if err != nil || len(encoded)+1 > 131072 {
		out.OK = false
		out.Error = "output-bound"
		out.Logs = nil
	}
	if ctx.Err() != nil || time.Since(started) >= budget || s.remaining() <= 0 {
		out.OK = false
		out.Error = "timed-out"
		out.Logs = nil
	}
	return
}

func uniqueLogJSON(raw []byte) bool {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var consume func(int) bool
	consume = func(depth int) bool {
		if depth > 32 {
			return false
		}
		v, e := d.Token()
		if e != nil {
			return false
		}
		delim, ok := v.(json.Delim)
		if !ok {
			return true
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, e := d.Token()
				name, ok := key.(string)
				if e != nil || !ok || seen[name] {
					return false
				}
				seen[name] = true
				if !consume(depth + 1) {
					return false
				}
			}
			end, e := d.Token()
			return e == nil && end == json.Delim('}')
		case '[':
			for d.More() {
				if !consume(depth + 1) {
					return false
				}
			}
			end, e := d.Token()
			return e == nil && end == json.Delim(']')
		}
		return false
	}
	return consume(0) && d.Decode(new(interface{})) == io.EOF
}
func projectLogBody(raw []byte, windowDigest string) ([]publicLog, error) {
	deny := errors.New("invalid log output")
	if !uniqueLogJSON(raw) {
		return nil, deny
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(raw, &root) != nil || root == nil {
		return nil, deny
	}
	// Presence is failure, including null/false/empty values. An error-bearing
	// provider envelope must never become a successful empty observation.
	if _, present := root["error"]; present {
		return nil, deny
	}
	if _, present := root["errors"]; present {
		return nil, deny
	}
	data, ok := root["data"]
	if !ok || len(data) == 0 || bytes.TrimSpace(data)[0] != '[' {
		return nil, deny
	}
	var records []json.RawMessage
	if json.Unmarshal(data, &records) != nil || len(records) > 2048 {
		return nil, deny
	}
	if meta, ok := root["meta"]; ok {
		var m map[string]json.RawMessage
		if json.Unmarshal(meta, &m) != nil || m == nil {
			return nil, deny
		}
		if token, ok := m["next_token"]; ok {
			var v string
			if json.Unmarshal(token, &v) != nil {
				return nil, deny
			}
		}
	}
	out := make([]publicLog, 0)
	for _, record := range records {
		var envelope map[string]json.RawMessage
		if json.Unmarshal(record, &envelope) != nil || envelope == nil {
			return nil, deny
		}
		var attrs map[string]json.RawMessage
		if json.Unmarshal(envelope["attributes"], &attrs) != nil || attrs == nil {
			return nil, deny
		}
		var row struct {
			Timestamp string `json:"timestamp"`
			Message   string `json:"message"`
			Instance  string `json:"instance"`
			Region    string `json:"region"`
		}
		attrsRaw, _ := json.Marshal(attrs)
		if json.Unmarshal(attrsRaw, &row) != nil {
			return nil, deny
		}
		if row.Instance != "0803730bd1d7e8" || row.Region != "ewr" || !validProviderTimestamp(row.Timestamp) || !strings.HasPrefix(row.Message, guardianExitPrefix) || len(row.Message) > 2000 {
			continue
		}
		message := []byte(strings.TrimPrefix(row.Message, guardianExitPrefix))
		if !validGuardianExit(message, windowDigest) {
			continue
		}
		if len(out) >= 128 {
			return nil, deny
		}
		// Only a closed public event has reached here. Preserve provider time
		// bytes, including nanoseconds; never forward raw envelope/app values.
		projected, err := canonical(message)
		if err != nil {
			return nil, deny
		}
		out = append(out, publicLog{Timestamp: row.Timestamp, Message: guardianExitPrefix + string(projected), Instance: row.Instance, Region: row.Region})
	}
	return out, nil
}
func validProviderTimestamp(v string) bool {
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$`).MatchString(v) {
		return false
	}
	_, e := time.Parse(time.RFC3339Nano, v)
	return e == nil
}
func canonicalLogTime(v string) bool {
	t, e := time.Parse("2006-01-02T15:04:05.000Z", v)
	return e == nil && t.Format("2006-01-02T15:04:05.000Z") == v
}
func validGuardianExit(raw []byte, window string) bool {
	if !uniqueLogJSON(raw) {
		return false
	}
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) != nil || len(keys) != 14 {
		return false
	}
	for _, k := range strings.Fields("version windowDigest bindingVerified code signal spawnFailed guardianPid parentPid exitedAt parentStartedAt readyDigest receiptDigest startDigest productionReady") {
		if _, ok := keys[k]; !ok {
			return false
		}
	}
	// Existing event schema has fourteen fields, not extensible arbitrary data.
	return validGuardianExitFields(raw, window)
}
func validGuardianExitFields(raw []byte, window string) bool {
	var v struct {
		Version    string          `json:"version"`
		Window     string          `json:"windowDigest"`
		Binding    *bool           `json:"bindingVerified"`
		Code       *int            `json:"code"`
		Signal     json.RawMessage `json:"signal"`
		Spawn      *bool           `json:"spawnFailed"`
		Guardian   int64           `json:"guardianPid"`
		Parent     int64           `json:"parentPid"`
		Exited     string          `json:"exitedAt"`
		Started    string          `json:"parentStartedAt"`
		Ready      string          `json:"readyDigest"`
		Receipt    string          `json:"receiptDigest"`
		Start      string          `json:"startDigest"`
		Production *bool           `json:"productionReady"`
	}
	if strict(raw, &v) != nil || v.Version != "p10b-guardian-child-exit-v1" || v.Window != window || v.Binding == nil || !*v.Binding || v.Code == nil || *v.Code != 0 || string(v.Signal) != "null" || v.Spawn == nil || *v.Spawn || v.Production == nil || *v.Production || v.Guardian <= 1 || v.Parent <= 1 || v.Guardian > 9007199254740991 || v.Parent > 9007199254740991 || !canonicalLogTime(v.Exited) || !canonicalLogTime(v.Started) {
		return false
	}
	for _, h := range []string{v.Ready, v.Receipt, v.Start} {
		if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(h) {
			return false
		}
	}
	return true
}

func serveLogs(input io.Reader, output io.Writer, factory func(context.Context) (doer, error)) error {
	return serveLogsContext(context.Background(), input, output, factory)
}
func runLogsMain() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT)
	defer cancel()
	return serveLogsContext(ctx, os.Stdin, os.Stdout, loadLogHTTP)
}
func serveLogsContext(ctx context.Context, input io.Reader, output io.Writer, factory func(context.Context) (doer, error)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 131072)
	if !scanner.Scan() {
		return errors.New("log initialization denied")
	}
	s, err := initializeLogs(scanner.Bytes(), factory)
	if err != nil {
		return err
	}
	ctx, lifetimeCancel := context.WithTimeout(ctx, s.remaining())
	defer lifetimeCancel()
	encoder := json.NewEncoder(output)
	if encoder.Encode(map[string]interface{}{"version": "p10b-native-log-ready-v1", "ready": true}) != nil {
		return errors.New("log output failed")
	}
	frames := make(chan []byte)
	done := make(chan error, 1)
	go func() {
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			select {
			case frames <- line:
			case <-ctx.Done():
				return
			}
		}
		done <- scanner.Err()
		cancel()
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-done:
			return err
		case raw := <-frames:
			var r logRequest
			if !uniqueLogJSON(raw) || strict(raw, &r) != nil {
				return errors.New("log input denied")
			}
			out := s.request(ctx, r)
			if encoder.Encode(out) != nil {
				return errors.New("log output failed")
			}
			if !out.OK {
				return errors.New("log request failed")
			}
		}
	}
}
