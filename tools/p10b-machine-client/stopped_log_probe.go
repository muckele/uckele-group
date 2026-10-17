package main

// A separate zero-start, zero-update transport diagnostic. It never creates a
// runtime session/window and never admits mutation or generic caller requests.
import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	fly "github.com/superfly/fly-go"
	"github.com/superfly/fly-go/tokens"
)

const stoppedLogProbeMachineEndpoint = "https://api.machines.dev/v1/apps/uckele-group-p10b/machines/0803730bd1d7e8"
const stoppedLogProbeBaselineImage = "sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629"

var stoppedLogProbeOperations = []string{"BASELINE_BEFORE", "LOG_FIRST", "LOG_STEADY", "BASELINE_AFTER"}

const stoppedLogProbeProfileKeys = "version operation app machineId volumeId hostSourceHead nativeClientSha256 nonce issuedAt expiresAt evidenceDirectory baselineConfig baselineConfigDigest baselineImageDigest baselineInstanceId maximumStarts maximumStoppedConfigUpdates maximumMachineReads maximumLogReads aggregateTimeoutMs cleanupReserveMs firstLogTimeoutMs steadyLogTimeoutMs machineTimeoutMs productionReady qualificationAllowed globalAutomationPaused providerCalls emails"
const stoppedLogProbeApprovalKeys = "version approved probeDigest hostSourceHead nativeClientSha256 expiresAt approvedAt"

type stoppedLogProbeProfile struct {
	Version          string          `json:"version"`
	Operation        string          `json:"operation"`
	App              string          `json:"app"`
	Machine          string          `json:"machineId"`
	Volume           string          `json:"volumeId"`
	Source           string          `json:"hostSourceHead"`
	Native           string          `json:"nativeClientSha256"`
	Nonce            string          `json:"nonce"`
	Issued           string          `json:"issuedAt"`
	Expires          string          `json:"expiresAt"`
	Directory        string          `json:"evidenceDirectory"`
	Baseline         json.RawMessage `json:"baselineConfig"`
	BaselineDigest   string          `json:"baselineConfigDigest"`
	BaselineImage    string          `json:"baselineImageDigest"`
	BaselineInstance string          `json:"baselineInstanceId"`
	Starts           int             `json:"maximumStarts"`
	Updates          int             `json:"maximumStoppedConfigUpdates"`
	MachineReads     int             `json:"maximumMachineReads"`
	LogReads         int             `json:"maximumLogReads"`
	Aggregate        int             `json:"aggregateTimeoutMs"`
	Cleanup          int             `json:"cleanupReserveMs"`
	FirstLog         int             `json:"firstLogTimeoutMs"`
	SteadyLog        int             `json:"steadyLogTimeoutMs"`
	MachineTimeout   int             `json:"machineTimeoutMs"`
	Production       bool            `json:"productionReady"`
	Qualification    bool            `json:"qualificationAllowed"`
	Paused           bool            `json:"globalAutomationPaused"`
	Provider         int             `json:"providerCalls"`
	Emails           int             `json:"emails"`
}
type stoppedLogProbeApproval struct {
	Version     string `json:"version"`
	Approved    bool   `json:"approved"`
	ProbeDigest string `json:"probeDigest"`
	Source      string `json:"hostSourceHead"`
	Native      string `json:"nativeClientSha256"`
	Expires     string `json:"expiresAt"`
	ApprovedAt  string `json:"approvedAt"`
}
type stoppedLogProbeRequest struct {
	ID        int    `json:"id"`
	Operation string `json:"operation"`
}
type stoppedLogProbeObservation struct {
	Kind               string `json:"kind"`
	State              string `json:"state,omitempty"`
	Instance           string `json:"instanceId,omitempty"`
	ConfigDigest       string `json:"configDigest,omitempty"`
	ImageDigest        string `json:"imageDigest,omitempty"`
	ProviderBatchEmpty *bool  `json:"providerBatchEmpty,omitempty"`
	HTTPStatus         int    `json:"httpStatus"`
	ElapsedMs          int64  `json:"elapsedMs"`
	Dispatched         bool   `json:"dispatched"`
}
type stoppedLogProbeResponse struct {
	Type        string                      `json:"type"`
	ID          int                         `json:"id"`
	Code        string                      `json:"code,omitempty"`
	Observation *stoppedLogProbeObservation `json:"observation,omitempty"`
}
type stoppedLogProbeService struct {
	profile    stoppedLogProbeProfile
	client     doer
	logs       *logService
	cutoff     time.Time
	anchor     time.Time
	lifetime   time.Duration
	now        func() time.Time
	elapsed    func() time.Duration
	failed     atomic.Bool
	mu         sync.Mutex
	next       int
	batchEmpty bool
}

func closedProbeObject(raw []byte, keys string, value interface{}) bool {
	if !uniqueLogJSON(raw) {
		return false
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return false
	}
	names := strings.Fields(keys)
	if len(m) != len(names) {
		return false
	}
	for _, key := range names {
		if value, ok := m[key]; !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	return strict(raw, value) == nil
}
func validStoppedLogProbeBaseline(raw []byte, image, digest string) bool {
	if !uniqueLogJSON(raw) {
		return false
	}
	c, e := canonical(raw)
	if e != nil || len(c) > 32768 || hash(c) != digest || !frozenBaseline(c, image) || !stoppedBaselineHardOff(c) {
		return false
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(c, &m) != nil {
		return false
	}
	allowed := map[string]bool{}
	for _, k := range strings.Fields("image env restart guest mounts services init processes auto_destroy schedule checks dns metadata metrics stop_config") {
		allowed[k] = true
	}
	for k := range m {
		if !allowed[k] {
			return false
		}
	}
	var env map[string]string
	if json.Unmarshal(m["env"], &env) != nil {
		return false
	}
	for _, key := range []string{"P10B_GUEST_WINDOW", "P10B_QUALIFICATION_RUNTIME", "P10B_QUALIFICATION_PHASE"} {
		if _, ok := env[key]; ok {
			return false
		}
	}
	return true
}
func initializeStoppedLogProbe(ctx context.Context, raw []byte, anchor time.Time, factory func(context.Context) (doer, error)) (*stoppedLogProbeService, error) {
	deny := errors.New("stopped log probe initialization denied")
	if ctx.Err() != nil || !time.Now().Before(anchor.Add(10*time.Second)) {
		return nil, deny
	}
	var packet struct {
		Probe    json.RawMessage `json:"probe"`
		Approval json.RawMessage `json:"approval"`
	}
	if !closedProbeObject(raw, "probe approval", &packet) {
		return nil, deny
	}
	var p stoppedLogProbeProfile
	var a stoppedLogProbeApproval
	if !closedProbeObject(packet.Probe, stoppedLogProbeProfileKeys, &p) || !closedProbeObject(packet.Approval, stoppedLogProbeApprovalKeys, &a) {
		return nil, deny
	}
	canonicalProbe, e := canonical(packet.Probe)
	if e != nil {
		return nil, deny
	}
	if p.BaselineImage != stoppedLogProbeBaselineImage {
		return nil, deny
	}
	if p.Version != "p10b-stopped-log-probe-v1" || p.Operation != "stopped-log-probe" || p.App != "uckele-group-p10b" || p.Machine != "0803730bd1d7e8" || p.Volume != "vol_vwnkpex1k3yx9dnv" || !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(p.Source) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(p.Native) || !regexp.MustCompile(`^[a-f0-9]{24}$`).MatchString(p.Nonce) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(p.BaselineDigest) || !regexp.MustCompile(`^[A-Za-z0-9-]{1,80}$`).MatchString(p.BaselineInstance) || len(p.Directory) > 1024 || !regexp.MustCompile(`^/[A-Za-z0-9_./ -]+$`).MatchString(p.Directory) || filepath.Clean(p.Directory) != p.Directory || p.Starts != 0 || p.Updates != 0 || p.MachineReads != 2 || p.LogReads != 2 || p.Aggregate != 30000 || p.Cleanup != 3000 || p.FirstLog != 5000 || p.SteadyLog != 700 || p.MachineTimeout != 1000 || p.Production || p.Qualification || !p.Paused || p.Provider != 0 || p.Emails != 0 || !validStoppedLogProbeBaseline(p.Baseline, p.BaselineImage, p.BaselineDigest) {
		return nil, deny
	}
	if a.Version != "p10b-stopped-log-probe-approval-v1" || !a.Approved || a.ProbeDigest != hash(canonicalProbe) || a.Source != p.Source || a.Native != p.Native || a.Expires != p.Expires || !canonicalLogTime(p.Issued) || !canonicalLogTime(p.Expires) || !canonicalLogTime(a.ApprovedAt) {
		return nil, deny
	}
	issued, _ := time.Parse(time.RFC3339Nano, p.Issued)
	expires, _ := time.Parse(time.RFC3339Nano, p.Expires)
	approved, _ := time.Parse(time.RFC3339Nano, a.ApprovedAt)
	cutoff := expires.Add(-3 * time.Second)
	if expires.Sub(issued) != 30*time.Second || anchor.Before(issued) || !anchor.Before(cutoff) || approved.Before(issued) || approved.After(anchor) {
		return nil, deny
	}
	s := &stoppedLogProbeService{profile: p, cutoff: cutoff, anchor: anchor, lifetime: cutoff.Sub(anchor), now: time.Now, elapsed: func() time.Duration { return time.Since(anchor) }}
	initEnd := anchor.Add(10 * time.Second)
	if cutoff.Before(initEnd) {
		initEnd = cutoff
	}
	ctx, cancel := context.WithDeadline(ctx, initEnd)
	defer cancel()
	if ctx.Err() != nil || s.remaining() <= 0 {
		return nil, deny
	}
	client, e := factory(ctx)
	if e != nil || client == nil || ctx.Err() != nil || s.remaining() <= 0 {
		return nil, deny
	}
	s.client = client
	s.logs = &logService{client: client, deadline: cutoff, now: s.now, elapsed: s.elapsed, lifetime: s.lifetime, project: func(raw []byte, _ string) ([]publicLog, error) {
		// Validate the exact reviewed envelope, but discard every app/guardian
		// row unconditionally. Empty is a provider batch fact, never a filter fact.
		if _, e := projectLogBody(raw, ""); e != nil {
			return nil, e
		}
		var root struct {
			Data []json.RawMessage `json:"data"`
		}
		if json.Unmarshal(raw, &root) != nil {
			return nil, errors.New("invalid-output")
		}
		s.batchEmpty = len(root.Data) == 0
		return []publicLog{}, nil
	}}
	return s, nil
}
func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
func (s *stoppedLogProbeService) remaining() time.Duration {
	now := s.now()
	if now.Before(s.anchor) {
		return 0
	}
	return minDuration(s.cutoff.Sub(now), s.lifetime-s.elapsed())
}

func (s *stoppedLogProbeService) request(ctx context.Context, r stoppedLogProbeRequest) (out stoppedLogProbeResponse) {
	started := time.Now()
	out = stoppedLogProbeResponse{Type: "error", ID: r.ID, Code: "request-denied"}
	if !s.mu.TryLock() {
		s.failed.Store(true)
		return
	}
	defer s.mu.Unlock()
	defer func() {
		if out.Type != "success" {
			s.failed.Store(true)
		}
	}()
	if s.failed.Load() || s.next >= len(stoppedLogProbeOperations) || r.ID != s.next+1 || r.Operation != stoppedLogProbeOperations[s.next] || ctx.Err() != nil || s.remaining() <= 0 {
		return
	}
	s.next++
	budget := time.Duration(s.profile.MachineTimeout) * time.Millisecond
	if r.Operation == "LOG_FIRST" {
		budget = time.Duration(s.profile.FirstLog) * time.Millisecond
	}
	if r.Operation == "LOG_STEADY" {
		budget = time.Duration(s.profile.SteadyLog) * time.Millisecond
	}
	budget = minDuration(budget, s.remaining())
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	var observation *stoppedLogProbeObservation
	if strings.HasPrefix(r.Operation, "LOG_") {
		timeoutMs := int(budget / time.Millisecond)
		if timeoutMs < 1 {
			out.Code = "timed-out"
			return
		}
		lr := s.logs.request(ctx, logRequest{ID: r.ID, Method: "GET", TimeoutMs: timeoutMs})
		if !lr.OK {
			out.Code = lr.Error
			return
		}
		empty := s.batchEmpty
		observation = &stoppedLogProbeObservation{Kind: "log", ProviderBatchEmpty: &empty, HTTPStatus: 200, Dispatched: true}
	} else {
		var code string
		observation, code = s.baseline(ctx)
		if code != "" {
			out.Code = code
			return
		}
	}
	observation.ElapsedMs = time.Since(started).Milliseconds()
	out = stoppedLogProbeResponse{Type: "success", ID: r.ID, Observation: observation}
	encoded, e := json.Marshal(out)
	if e != nil || len(encoded)+1 > 131072 {
		out = stoppedLogProbeResponse{Type: "error", ID: r.ID, Code: "output-bound"}
		return
	}
	if s.failed.Load() || ctx.Err() != nil || time.Since(started) >= budget || s.remaining() <= 0 {
		out = stoppedLogProbeResponse{Type: "error", ID: r.ID, Code: "timed-out"}
	}
	return
}
func (s *stoppedLogProbeService) baseline(ctx context.Context) (*stoppedLogProbeObservation, string) {
	req, e := http.NewRequestWithContext(ctx, "GET", stoppedLogProbeMachineEndpoint, nil)
	if e != nil {
		return nil, "request-failed"
	}
	req.Close = true
	req.GetBody = nil
	response, e := s.client.Do(req)
	if e != nil {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		if ctx.Err() != nil {
			return nil, "timed-out"
		}
		return nil, "request-failed"
	}
	if response == nil || response.Body == nil {
		return nil, "invalid-output"
	}
	closed := false
	defer func() {
		if !closed {
			response.Body.Close()
		}
	}()
	if response.StatusCode != 200 {
		return nil, "http-failed"
	}
	if response.Header.Get("Content-Encoding") != "" {
		return nil, "invalid-output"
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, 131073))
	closeErr := response.Body.Close()
	closed = true
	if len(raw) > 131072 {
		return nil, "output-bound"
	}
	if e != nil || closeErr != nil {
		if ctx.Err() != nil {
			return nil, "timed-out"
		}
		return nil, "request-failed"
	}
	if ctx.Err() != nil || s.remaining() <= 0 {
		return nil, "timed-out"
	}
	if !uniqueLogJSON(raw) {
		return nil, "invalid-output"
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(raw, &root) != nil || root == nil {
		return nil, "invalid-output"
	}
	if _, ok := root["error"]; ok {
		return nil, "invalid-output"
	}
	if _, ok := root["errors"]; ok {
		return nil, "invalid-output"
	}
	projection := &service{allowedConfig: map[string]bool{s.profile.BaselineDigest: true}}
	public, e := projection.machine(raw)
	if e != nil {
		return nil, "invalid-output"
	}
	var m struct {
		State    string          `json:"state"`
		Instance string          `json:"instance_id"`
		Config   json.RawMessage `json:"config"`
		Image    struct {
			Digest string `json:"digest"`
		} `json:"image_ref"`
	}
	if json.Unmarshal(public, &m) != nil || m.State != "stopped" || m.Instance != s.profile.BaselineInstance || m.Image.Digest != s.profile.BaselineImage || !validStoppedLogProbeBaseline(m.Config, s.profile.BaselineImage, s.profile.BaselineDigest) {
		return nil, "invalid-output"
	}
	return &stoppedLogProbeObservation{Kind: "baseline", State: "stopped", Instance: s.profile.BaselineInstance, ConfigDigest: s.profile.BaselineDigest, ImageDigest: s.profile.BaselineImage, HTTPStatus: 200, Dispatched: true}, ""
}

type stoppedLogProbeSDKDoer struct {
	client *http.Client
	opaque *tokens.Tokens
}

func (c *stoppedLogProbeSDKDoer) Do(r *http.Request) (*http.Response, error) {
	if r.Method != "GET" || r.Body != nil || r.GetBody != nil {
		return nil, errors.New("request denied")
	}
	var header string
	switch r.URL.String() {
	case stoppedLogProbeMachineEndpoint:
		header = c.opaque.FlapsHeader()
	case logEndpoint:
		header = c.opaque.BubblegumHeader()
	default:
		return nil, errors.New("request denied")
	}
	return c.client.Do(r.WithContext(fly.WithAuthorizationHeader(r.Context(), header)))
}
func newStoppedLogProbeHTTP(token string, transport http.RoundTripper) (doer, error) {
	if token == "" || len(token) > 32768 || strings.ContainsAny(token, "\r\n\x00") {
		return nil, errors.New("authentication unavailable")
	}
	opaque := tokens.Parse(token)
	return &stoppedLogProbeSDKDoer{opaque: opaque, client: &http.Client{Transport: &fly.Transport{Tokens: opaque, UserAgent: "p10b-stopped-log-probe-v1", UnderlyingTransport: transport}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func loadStoppedLogProbeHTTP(context.Context) (doer, error) {
	if os.Getenv("P10B_APP_TOKEN_CONTEXT") != "p10b-app-token-context-v1" {
		return nil, errors.New("authentication unavailable")
	}
	return newStoppedLogProbeHTTP(os.Getenv("FLY_API_TOKEN"), restrictedLogTransport())
}

func runStoppedLogProbeMain() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT)
	defer cancel()
	return serveStoppedLogProbe(ctx, os.Stdin, os.Stdout, loadStoppedLogProbeHTTP)
}
func writeStoppedLogProbeFrame(ctx context.Context, encoder *json.Encoder, value interface{}) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	done := make(chan error, 1)
	go func() { done <- encoder.Encode(value) }()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case e := <-done:
		if e != nil {
			return errors.New("output failed")
		}
		return ctx.Err()
	}
}
func serveStoppedLogProbe(ctx context.Context, input io.Reader, output io.Writer, factory func(context.Context) (doer, error)) error {
	anchor := time.Now()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 131072)
	frames := make(chan []byte)
	done := make(chan error, 1)
	readerCtx := ctx
	go func() {
		for scanner.Scan() {
			raw := bytes.Clone(scanner.Bytes())
			select {
			case frames <- raw:
			case <-readerCtx.Done():
				return
			}
		}
		done <- scanner.Err()
		cancel()
	}()
	var initial []byte
	initTimer := time.NewTimer(time.Until(anchor.Add(10 * time.Second)))
	defer initTimer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-initTimer.C:
		return errors.New("initialization timed out")
	case initial = <-frames:
	}
	s, e := initializeStoppedLogProbe(ctx, initial, anchor, factory)
	if e != nil {
		return e
	}
	if ctx.Err() != nil || time.Since(anchor) >= 10*time.Second || s.remaining() <= 0 {
		return errors.New("initialization timed out")
	}
	ctx, lifetimeCancel := context.WithTimeout(ctx, s.remaining())
	defer lifetimeCancel()
	encoder := json.NewEncoder(output)
	readyCtx, readyCancel := context.WithDeadline(ctx, anchor.Add(10*time.Second))
	defer readyCancel()
	if e := writeStoppedLogProbeFrame(readyCtx, encoder, map[string]string{"type": "ready", "version": "p10b-stopped-log-probe-v1"}); e != nil {
		return e
	}
	if ctx.Err() != nil || s.remaining() <= 0 {
		return errors.New("initialization timed out")
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case e := <-done:
			return e
		case raw := <-frames:
			stepAnchor := time.Now()
			var r stoppedLogProbeRequest
			if !closedProbeObject(raw, "id operation", &r) {
				s.failed.Store(true)
				return errors.New("input denied")
			}
			// A second frame while a step is active is concurrent admission and
			// poisons the single probe instead of queuing another remote request.
			activeDone := make(chan stoppedLogProbeResponse, 1)
			stepBudget := time.Second
			if r.Operation == "LOG_FIRST" {
				stepBudget = 5 * time.Second
			}
			if r.Operation == "LOG_STEADY" {
				stepBudget = 700 * time.Millisecond
			}
			stepCtx, stepCancel := context.WithDeadline(ctx, stepAnchor.Add(stepBudget))
			defer stepCancel()
			go func() { activeDone <- s.request(stepCtx, r) }()
			var result stoppedLogProbeResponse
			select {
			case <-stepCtx.Done():
				return stepCtx.Err()
			case <-frames:
				s.failed.Store(true)
				cancel()
				return errors.New("concurrent input denied")
			case result = <-activeDone:
			}
			if s.remaining() <= 0 || ctx.Err() != nil {
				return errors.New("publication timed out")
			}
			if e := writeStoppedLogProbeFrame(stepCtx, encoder, result); e != nil {
				return e
			}
			if s.remaining() <= 0 || stepCtx.Err() != nil {
				return errors.New("publication timed out")
			}
			stepCancel()
			if result.Type != "success" {
				return errors.New("request failed")
			}
		}
	}
}
