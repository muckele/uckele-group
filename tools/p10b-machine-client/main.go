// Fixed-target authenticated client. Only Fly's normal config/SDK owns opaque
// credentials; no token conversion, header export, login, metrics or proxy.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/pflag"
	"github.com/superfly/fly-go/flaps"
	"github.com/superfly/flyctl/helpers"
	"github.com/superfly/flyctl/internal/config"
	"github.com/superfly/flyctl/internal/flag/flagctx"
)

const endpoint = "/apps/uckele-group-p10b/machines/0803730bd1d7e8"

type requestBuilder interface {
	NewRequest(context.Context, string, string, interface{}, map[string][]string) (*http.Request, error)
}
type doer interface {
	Do(*http.Request) (*http.Response, error)
}
type request struct {
	ID        int             `json:"id"`
	Method    string          `json:"method"`
	TimeoutMs int             `json:"timeoutMs"`
	Body      json.RawMessage `json:"body,omitempty"`
}
type response struct {
	ID      int             `json:"id"`
	OK      bool            `json:"ok"`
	Error   string          `json:"error,omitempty"`
	Machine json.RawMessage `json:"machine,omitempty"`
}
type service struct {
	builder       requestBuilder
	client        doer
	deadline      time.Time
	readOnly      bool
	allowedConfig map[string]bool
	posts, reads  int
	source, image string
}
type initPacket struct {
	Version          string            `json:"version"`
	Approved         bool              `json:"approved"`
	ReadOnly         bool              `json:"readOnly"`
	SessionCanonical string            `json:"sessionCanonical"`
	SessionDigest    string            `json:"sessionDigest"`
	Configs          []json.RawMessage `json:"configs"`
	RecoveryVerified bool              `json:"recoveryVerified"`
}

func hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func canonical(raw []byte) ([]byte, error) {
	var v interface{}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	err := e.Encode(v)
	return bytes.TrimSpace(b.Bytes()), err
}
func strict(raw []byte, v interface{}) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.Decode(new(interface{})) != io.EOF {
		return errors.New("trailing input")
	}
	return nil
}
func loadClient(ctx context.Context) (requestBuilder, error) {
	ctx = flagctx.NewContext(ctx, pflag.NewFlagSet("p10b-native", pflag.ContinueOnError))
	dir, err := helpers.GetConfigDirectory()
	if err != nil {
		return nil, errors.New("native authentication unavailable")
	}
	cfg, err := config.Load(ctx, filepath.Join(dir, config.FileName))
	if err != nil {
		return nil, errors.New("native authentication unavailable")
	}
	return flaps.NewWithOptions(ctx, flaps.NewClientOpts{Tokens: cfg.Tokens})
}
func initialize(raw []byte, factory func(context.Context) (requestBuilder, error)) (*service, error) {
	var p initPacket
	if strict(raw, &p) != nil || p.Version != "p10b-native-init-v1" || !p.Approved || hash([]byte(p.SessionCanonical)) != p.SessionDigest {
		return nil, errors.New("native initialization denied")
	}
	var session struct {
		App           string          `json:"app"`
		Machine       string          `json:"machineId"`
		Source        string          `json:"sourceHead"`
		Image         string          `json:"candidateImageDigest"`
		Started       string          `json:"startedAt"`
		Deadline      string          `json:"sessionDeadline"`
		Owner         string          `json:"ownerPermissionDigest"`
		Nonce         string          `json:"nonce"`
		Baseline      json.RawMessage `json:"baselineConfig"`
		Version       string          `json:"version"`
		BaselineImage string          `json:"baselineImageDigest"`
		Starts        int             `json:"maximumStarts"`
		Window        int             `json:"maximumStartWindowMs"`
		Updates       int             `json:"maximumStoppedConfigUpdates"`
		Production    bool            `json:"productionReady"`
		Paused        bool            `json:"globalAutomationPaused"`
	}
	if json.Unmarshal([]byte(p.SessionCanonical), &session) != nil || session.Version != "p10b-no-email-session-v1" || session.Starts != 2 || session.Window != 300000 || session.Updates != 3 || session.Production || !session.Paused || !frozenBaseline(session.Baseline, session.BaselineImage) || session.App != "uckele-group-p10b" || session.Machine != "0803730bd1d7e8" || !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(session.Source) || !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(session.Image) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(session.Owner) || (!p.ReadOnly && !p.RecoveryVerified) {
		return nil, errors.New("native initialization denied")
	}
	start, e1 := time.Parse(time.RFC3339Nano, session.Started)
	end, e2 := time.Parse(time.RFC3339Nano, session.Deadline)
	if e1 != nil || e2 != nil || end.Sub(start) != time.Hour || time.Now().Before(start) || !time.Now().Before(end) || len(p.Configs) < 1 || len(p.Configs) > 3 {
		return nil, errors.New("native initialization denied")
	}
	allowed := map[string]bool{}
	for _, c := range p.Configs {
		if !boundConfig(c, session.Baseline, session.Source, session.Image, session.Nonce, session.Owner, start, end) {
			return nil, errors.New("native public configuration denied")
		}
		b, err := canonical(c)
		if err != nil {
			return nil, errors.New("native public configuration denied")
		}
		allowed[hash(b)] = true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	b, err := factory(ctx)
	if err != nil {
		return nil, errors.New("native authentication unavailable")
	}
	return &service{builder: b, client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect denied") }}, deadline: end, readOnly: p.ReadOnly, allowedConfig: allowed, source: session.Source, image: session.Image}, nil
}
func publicConfig(raw []byte) bool {
	var c map[string]json.RawMessage
	if json.Unmarshal(raw, &c) != nil {
		return false
	}
	var env map[string]string
	if e, ok := c["env"]; ok && json.Unmarshal(e, &env) != nil {
		return false
	}
	names := strings.Fields("NODE_ENV P10B_QUALIFICATION_RUNTIME STORAGE_PROVIDER PORT HOST TZ APP_BASE_URL PUBLIC_BASE_URL LOG_LEVEL SQLITE_PATH P10B_QUALIFICATION_PHASE P10B_GUEST_WINDOW DEAL_HUNTER_CIM_PROVIDER_PROFILE DEAL_HUNTER_CIM_PROVIDER_ENABLED DEAL_HUNTER_CIM_OUTREACH_PAUSED DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED DEAL_HUNTER_CIM_AUTOMATION_PAUSED DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED DEAL_HUNTER_DAILY_EMAIL_ENABLED FOLLOW_UP_EMAIL_ENABLED FOLLOW_UP_AI_ENABLED DELIVERY_PROVIDER DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL DEAL_HUNTER_CIM_MAILBOX_REPLY_TO DEAL_HUNTER_CIM_MAILBOX_INBOUND_DOMAIN DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS")
	allowed := map[string]bool{}
	for _, n := range names {
		allowed[n] = true
	}
	for k, v := range env {
		if !allowed[k] || len(v) > 4096 || regexp.MustCompile(`(?i)https?://[^/]*@|postgres(?:ql)?:|Bearer\s`).MatchString(v) {
			return false
		}
	}
	return true
}
func (s *service) request(ctx context.Context, r request) response {
	denied := response{ID: r.ID, Error: "request-denied"}
	if (r.Method != "GET" && r.Method != "POST") || r.TimeoutMs < 1 || r.TimeoutMs > 10000 || !time.Now().Before(s.deadline) || s.reads >= 8192 {
		return denied
	}
	var in interface{}
	path := endpoint
	if r.Method == "POST" {
		var body struct {
			Config         json.RawMessage `json:"config"`
			CurrentVersion string          `json:"current_version"`
			SkipLaunch     bool            `json:"skip_launch"`
		}
		if s.readOnly || s.posts >= 3 || strict(r.Body, &body) != nil || !body.SkipLaunch || !regexp.MustCompile(`^[A-Za-z0-9-]{1,80}$`).MatchString(body.CurrentVersion) || !publicConfig(body.Config) {
			return denied
		}
		c, err := canonical(body.Config)
		if err != nil || !s.allowedConfig[hash(c)] {
			return denied
		}
		s.posts++
		in = json.RawMessage(r.Body)
	} else {
		if len(r.Body) > 0 {
			return denied
		}
		s.reads++
		in = json.RawMessage(`null`)
	}
	duration := time.Duration(r.TimeoutMs) * time.Millisecond
	if left := time.Until(s.deadline); duration > left {
		duration = left
	}
	ctx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	req, err := s.builder.NewRequest(ctx, r.Method, path, in, nil)
	if err != nil {
		return response{ID: r.ID, Error: "request-failed"}
	}
	if req.URL.Scheme != "https" || req.URL.Host != "api.machines.dev" || req.URL.Path != "/v1"+endpoint || req.URL.RawQuery != "" || req.URL.User != nil {
		return denied
	}
	// Direct Do: SDK retry wrappers and replayable mutation bodies are excluded.
	req.GetBody = nil
	req.Header.Del("Idempotency-Key")
	req.Header.Del("X-Idempotency-Key")
	if ctx.Err() != nil || !time.Now().Before(s.deadline) {
		return response{ID: r.ID, Error: "timed-out"}
	}
	res, err := s.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return response{ID: r.ID, Error: "timed-out"}
		}
		return response{ID: r.ID, Error: "request-failed"}
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return response{ID: r.ID, Error: "http-failed"}
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 1048577))
	if err != nil || len(b) > 1048576 {
		return response{ID: r.ID, Error: "output-bound"}
	}
	machine, err := s.machine(b)
	if err != nil {
		return response{ID: r.ID, Error: "invalid-output"}
	}
	if ctx.Err() != nil || !time.Now().Before(s.deadline) {
		return response{ID: r.ID, Error: "timed-out"}
	}
	return response{ID: r.ID, OK: true, Machine: machine}
}
func (s *service) machine(raw []byte) ([]byte, error) {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return nil, errors.New("invalid-output")
	}
	var id, region, state, instance string
	json.Unmarshal(m["id"], &id)
	json.Unmarshal(m["region"], &region)
	json.Unmarshal(m["state"], &state)
	json.Unmarshal(m["instance_id"], &instance)
	c, err := canonical(m["config"])
	if err != nil || id != "0803730bd1d7e8" || region != "ewr" || !regexp.MustCompile(`^[A-Za-z0-9-]{1,80}$`).MatchString(instance) || !s.allowedConfig[hash(c)] || !publicConfig(c) {
		return nil, errors.New("invalid-output")
	}
	if !map[string]bool{"stopped": true, "started": true, "starting": true, "stopping": true, "created": true, "replacing": true}[state] {
		return nil, errors.New("invalid-output")
	}
	var image struct {
		Digest string `json:"digest"`
	}
	if json.Unmarshal(m["image_ref"], &image) != nil || !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(image.Digest) {
		return nil, errors.New("invalid-output")
	}
	// Exact approved config only; arbitrary API fields and error messages never
	// cross IPC. Events are reduced to lifecycle proof fields below.
	out := map[string]interface{}{"id": id, "region": region, "state": state, "instance_id": instance, "config": json.RawMessage(c), "image_ref": image, "events": safeEvents(m["events"])}
	return json.Marshal(out)
}
func safeEvents(raw []byte) []interface{} {
	var events []map[string]json.RawMessage
	json.Unmarshal(raw, &events)
	out := []interface{}{}
	if len(events) > 128 {
		return out
	}
	for _, e := range events {
		var kind, status string
		json.Unmarshal(e["type"], &kind)
		json.Unmarshal(e["status"], &status)
		if kind != "exit" || status != "stopped" {
			continue
		}
		var rq struct {
			Exit map[string]json.RawMessage `json:"exit_event"`
		}
		if json.Unmarshal(e["request"], &rq) != nil || rq.Exit == nil {
			continue
		}
		v := map[string]interface{}{}
		valid := true
		var at string
		if json.Unmarshal(rq.Exit["exited_at"], &at) != nil {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, at)
		if err != nil {
			continue
		}
		v["exited_at"] = t.UTC().Format("2006-01-02T15:04:05.000Z")
		for _, k := range []string{"requested_stop", "restarting", "oom_killed"} {
			var x bool
			if json.Unmarshal(rq.Exit[k], &x) != nil || string(rq.Exit[k]) == "null" {
				valid = false
			}
			v[k] = x
		}
		for _, k := range []string{"guest_exit_code", "exit_code", "guest_signal", "signal"} {
			var x int
			if json.Unmarshal(rq.Exit[k], &x) != nil || string(rq.Exit[k]) == "null" || x < -1 || x > 255 {
				valid = false
			}
			v[k] = x
		}
		for _, k := range []string{"guest_error", "error"} {
			var x string
			if json.Unmarshal(rq.Exit[k], &x) != nil || len(rq.Exit[k]) < 2 || rq.Exit[k][0] != '"' {
				valid = false
			}
			if x == "" {
				v[k] = ""
			} else {
				v[k] = "redacted"
			}
		}
		if valid {
			out = append(out, map[string]interface{}{"type": "exit", "status": "stopped", "request": map[string]interface{}{"exit_event": v}})
		}
	}
	return out
}
func boundConfig(raw, baseline json.RawMessage, source, image, nonce, owner string, start, end time.Time) bool {
	if !publicConfig(raw) || !publicConfig(baseline) || !regexp.MustCompile(`^[a-f0-9]{24}$`).MatchString(nonce) {
		return false
	}
	c, ec := canonical(raw)
	b, eb := canonical(baseline)
	if ec != nil || eb != nil {
		return false
	}
	if bytes.Equal(c, b) {
		return true
	}
	var v, base map[string]json.RawMessage
	json.Unmarshal(c, &v)
	json.Unmarshal(b, &base)
	var ci string
	json.Unmarshal(v["image"], &ci)
	if ci != "registry.fly.io/uckele-group-p10b@"+image {
		return false
	}
	var env, baseEnv map[string]string
	json.Unmarshal(v["env"], &env)
	json.Unmarshal(base["env"], &baseEnv)
	expected := map[string]string{"NODE_ENV": "p10b", "P10B_QUALIFICATION_RUNTIME": "true", "STORAGE_PROVIDER": "sqlite", "P10B_QUALIFICATION_PHASE": "prepare",
		"DEAL_HUNTER_CIM_PROVIDER_PROFILE": "controlled-mailbox-v1", "DEAL_HUNTER_CIM_PROVIDER_ENABLED": "false", "DEAL_HUNTER_CIM_OUTREACH_PAUSED": "true", "DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED": "false", "DEAL_HUNTER_CIM_AUTOMATION_PAUSED": "true", "DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED": "false", "DEAL_HUNTER_DAILY_EMAIL_ENABLED": "false", "FOLLOW_UP_EMAIL_ENABLED": "false", "FOLLOW_UP_AI_ENABLED": "false", "DELIVERY_PROVIDER": "console",
		"DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL": "P10B Sender <sender@p10b-e2e.uckelegroup.com>", "DEAL_HUNTER_CIM_MAILBOX_REPLY_TO": "replies@p10b-e2e.uckelegroup.com", "DEAL_HUNTER_CIM_MAILBOX_INBOUND_DOMAIN": "p10b-e2e.uckelegroup.com", "DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS": "mathew@uckelegroup.com"}
	var w struct {
		Version  string `json:"version"`
		App      string `json:"app"`
		Machine  string `json:"machineId"`
		Source   string `json:"sourceHead"`
		Image    string `json:"imageDigest"`
		Phase    string `json:"phase"`
		Database string `json:"databasePath"`
		Issued   string `json:"issuedAt"`
		Stop     string `json:"stopAt"`
		Grace    int    `json:"closureGraceMs"`
		Reserve  int    `json:"stopReserveMs"`
		Binding  string `json:"runBinding"`
	}
	if strict([]byte(env["P10B_GUEST_WINDOW"]), &w) != nil {
		return false
	}
	issued, e1 := time.Parse(time.RFC3339Nano, w.Issued)
	stop, e2 := time.Parse(time.RFC3339Nano, w.Stop)
	if e1 != nil || e2 != nil || issued.Before(start) || !stop.Before(end) || stop.Sub(issued) != 5*time.Minute || w.App != "uckele-group-p10b" || w.Machine != "0803730bd1d7e8" || w.Source != source || w.Image != image || w.Phase != "prepare" || w.Version != "p10b-guest-window-v1" || w.Grace != 30000 || w.Reserve != 30000 || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(w.Binding) {
		return false
	}
	label := "nosend"
	if strings.Contains(w.Database, "-watchdog-") {
		label = "watchdog"
	}
	if w.Database != "/data/p10b-first-mailbox-"+label+"-"+nonce+".sqlite" || env["SQLITE_PATH"] != w.Database {
		return false
	}
	identity := "prepare-" + nonce
	if label == "watchdog" {
		identity = "demo-" + nonce
	}
	binding, _ := json.Marshal(map[string]string{"identity": identity, "ownerPermissionDigest": owner})
	if w.Binding != hash(binding) {
		return false
	}
	expected["SQLITE_PATH"] = w.Database
	expected["P10B_GUEST_WINDOW"] = env["P10B_GUEST_WINDOW"]
	for k, x := range expected {
		if env[k] != x {
			return false
		}
	}
	for k, x := range env {
		if _, ok := expected[k]; !ok && baseEnv[k] != x {
			return false
		}
	}
	for k, x := range baseEnv {
		if _, ok := expected[k]; !ok && env[k] != x {
			return false
		}
	}
	first := `{"exec":["node","server/index.js"]}`
	if label == "watchdog" {
		first = `{"exec":["node","-e","setInterval(() => {}, 2147483647)"],"ignore_app_secrets":true}`
	}
	processes, _ := canonical([]byte("[" + first + `,{"exec":["node","scripts/run-p10b-guest-guardian-parent.js"],"ignore_app_secrets":true}]`))
	actual, _ := canonical(v["processes"])
	if !bytes.Equal(processes, actual) {
		return false
	}
	for _, k := range []string{"image", "env", "processes"} {
		delete(v, k)
		delete(base, k)
	}
	vr, _ := json.Marshal(v)
	br, _ := json.Marshal(base)
	return bytes.Equal(vr, br)
}
func serve(input io.Reader, output io.Writer, factory func(context.Context) (requestBuilder, error)) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 131072)
	if !scanner.Scan() {
		return errors.New("native initialization denied")
	}
	s, err := initialize(scanner.Bytes(), factory)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(output)
	if encoder.Encode(map[string]interface{}{"version": "p10b-native-ready-v1", "ready": true}) != nil {
		return errors.New("native output failed")
	}
	previous := 0
	for scanner.Scan() {
		var r request
		if strict(scanner.Bytes(), &r) != nil || r.ID <= previous {
			return errors.New("native input denied")
		}
		previous = r.ID
		if encoder.Encode(s.request(context.Background(), r)) != nil {
			return errors.New("native output failed")
		}
	}
	return scanner.Err()
}
func main() {
	if len(os.Args) != 2 || os.Args[1] != "--serve" {
		fmt.Fprintln(os.Stderr, "Native client requires explicit approved session.")
		os.Exit(1)
	}
	if serve(os.Stdin, os.Stdout, loadClient) != nil {
		fmt.Fprintln(os.Stderr, "Native client failed; retain public diagnostics.")
		os.Exit(1)
	}
}

func frozenBaseline(raw json.RawMessage, image string) bool {
	if !publicConfig(raw) {
		return false
	}
	var c struct {
		Image string `json:"image"`
		Guest struct {
			Kind   string `json:"cpu_kind"`
			Cpus   int    `json:"cpus"`
			Memory int    `json:"memory_mb"`
		} `json:"guest"`
		Restart struct {
			Policy string `json:"policy"`
		} `json:"restart"`
		Mounts []struct {
			Volume string `json:"volume"`
			Path   string `json:"path"`
		} `json:"mounts"`
		Services []struct {
			Autostart bool `json:"autostart"`
			Autostop  bool `json:"autostop"`
			Port      int  `json:"internal_port"`
		} `json:"services"`
		Destroy  bool          `json:"auto_destroy"`
		Files    []interface{} `json:"files"`
		Schedule string        `json:"schedule"`
		Init     struct {
			Exec       []string `json:"exec"`
			Cmd        []string `json:"cmd"`
			Entrypoint []string `json:"entrypoint"`
		} `json:"init"`
	}
	if json.Unmarshal(raw, &c) != nil || !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(image) || !strings.HasSuffix(c.Image, "@"+image) || c.Guest.Kind != "shared" || c.Guest.Cpus != 1 || c.Guest.Memory != 512 || c.Restart.Policy != "no" || len(c.Mounts) != 1 || c.Mounts[0].Volume != "vol_vwnkpex1k3yx9dnv" || c.Mounts[0].Path != "/data" || len(c.Services) != 1 || c.Services[0].Autostart || c.Services[0].Autostop || c.Services[0].Port != 8787 || c.Destroy || len(c.Files) != 0 || c.Schedule != "" || len(c.Init.Exec)+len(c.Init.Cmd)+len(c.Init.Entrypoint) != 0 {
		return false
	}
	return true
}
