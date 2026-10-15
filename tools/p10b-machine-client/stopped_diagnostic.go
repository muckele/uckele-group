package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type requestObservation struct {
	HTTPStatus *int  `json:"httpStatus"`
	ElapsedMs  int64 `json:"elapsedMs"`
	// Dispatch means Do was called; it is not proof of remote acceptance.
	Dispatched bool `json:"dispatched"`
}
type stoppedDiagnosticPolicy struct {
	baseline, candidate, baselineVersion string
	lastConfig, lastVersion              string
	lastStopped                          bool
	lastAt                               time.Time
}

func enableStoppedDiagnostic(s *service, baseline, candidate []byte, version string) {
	s.diagnostic = &stoppedDiagnosticPolicy{baseline: hash(baseline), candidate: hash(candidate), baselineVersion: version}
}
func (d *stoppedDiagnosticPolicy) writeAllowed(posts int, config, version string) bool {
	if !d.lastStopped || time.Since(d.lastAt) > time.Second || version != d.lastVersion {
		return false
	}
	if posts == 0 {
		return config == d.candidate && d.lastConfig == d.baseline && version == d.baselineVersion
	}
	return posts == 1 && config == d.baseline && d.lastConfig == d.candidate && version != d.baselineVersion
}
func (d *stoppedDiagnosticPolicy) observe(m map[string]json.RawMessage) {
	var state string
	json.Unmarshal(m["state"], &state)
	json.Unmarshal(m["instance_id"], &d.lastVersion)
	config, _ := canonical(m["config"])
	d.lastConfig = hash(config)
	d.lastStopped = state == "stopped"
	d.lastAt = time.Now()
}
func stoppedBaselineHardOff(raw []byte) bool {
	var config struct {
		Env map[string]string `json:"env"`
	}
	if json.Unmarshal(raw, &config) != nil {
		return false
	}
	expected := map[string]string{"NODE_ENV": "p10b", "P10B_QUALIFICATION_RUNTIME": "true", "STORAGE_PROVIDER": "sqlite", "P10B_QUALIFICATION_PHASE": "prepare",
		"DEAL_HUNTER_CIM_PROVIDER_PROFILE": "controlled-mailbox-v1", "DEAL_HUNTER_CIM_PROVIDER_ENABLED": "false", "DEAL_HUNTER_CIM_OUTREACH_PAUSED": "true", "DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED": "false", "DEAL_HUNTER_CIM_AUTOMATION_PAUSED": "true", "DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED": "false", "DEAL_HUNTER_DAILY_EMAIL_ENABLED": "false", "FOLLOW_UP_EMAIL_ENABLED": "false", "FOLLOW_UP_AI_ENABLED": "false", "DELIVERY_PROVIDER": "console",
		"DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL": "P10B Sender <sender@p10b-e2e.uckelegroup.com>", "DEAL_HUNTER_CIM_MAILBOX_REPLY_TO": "replies@p10b-e2e.uckelegroup.com", "DEAL_HUNTER_CIM_MAILBOX_INBOUND_DOMAIN": "p10b-e2e.uckelegroup.com", "DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS": "mathew@uckelegroup.com"}
	delete(expected, "P10B_QUALIFICATION_RUNTIME")
	delete(expected, "P10B_QUALIFICATION_PHASE")
	for key, value := range expected {
		if config.Env[key] != value {
			return false
		}
	}
	return true
}
func initializeStoppedDiagnostic(raw []byte, factory func(context.Context) (requestBuilder, error)) (*service, error) {
	denied := errors.New("Stopped diagnostic initialization denied")
	var packet initPacket
	if strict(raw, &packet) != nil || packet.Version != "p10b-stopped-native-init-v1" || !packet.Approved || hash([]byte(packet.SessionCanonical)) != packet.SessionDigest || (!packet.ReadOnly && !packet.RecoveryVerified) {
		return nil, denied
	}
	var session struct {
		Version         string          `json:"version"`
		Operation       string          `json:"operation"`
		App             string          `json:"app"`
		Machine         string          `json:"machineId"`
		Volume          string          `json:"volumeId"`
		Source          string          `json:"sourceHead"`
		Image           string          `json:"candidateImageDigest"`
		BaselineImage   string          `json:"baselineImageDigest"`
		Baseline        json.RawMessage `json:"baselineConfig"`
		Candidate       json.RawMessage `json:"diagnosticConfig"`
		CandidateDigest string          `json:"diagnosticConfigDigest"`
		BaselineVersion string          `json:"baselineInstanceId"`
		Nonce           string          `json:"nonce"`
		Owner           string          `json:"ownerPermissionDigest"`
		Started         string          `json:"startedAt"`
		Deadline        string          `json:"sessionDeadline"`
		Starts          *int            `json:"maximumStarts"`
		Window          *int            `json:"maximumStartWindowMs"`
		Qualification   *bool           `json:"qualificationAllowed"`
		DiagnosticPosts int             `json:"maximumDiagnosticPosts"`
		RestorePosts    int             `json:"maximumRestorationPosts"`
		Updates         int             `json:"maximumStoppedConfigUpdates"`
		Timeout         int             `json:"requestTimeoutMs"`
		Observe         int             `json:"maximumObservationMs"`
		Run             int             `json:"maximumRunMs"`
		Builds          *int            `json:"maximumLocalBuilds"`
		Pushes          *int            `json:"maximumImagePushes"`
		Production      *bool           `json:"productionReady"`
		Paused          bool            `json:"globalAutomationPaused"`
	}
	if json.Unmarshal([]byte(packet.SessionCanonical), &session) != nil || session.Version != "p10b-stopped-update-session-v1" || session.Operation != "stopped-update-diagnostic" || session.App != "uckele-group-p10b" || session.Machine != "0803730bd1d7e8" || session.Volume != "vol_vwnkpex1k3yx9dnv" || session.Source != "c4944a46ac362cdcd002e077d5533b4b0843b1d0" || session.Image != "sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc" || session.BaselineImage != "sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629" || session.Starts == nil || *session.Starts != 0 || session.Window == nil || *session.Window != 0 || session.Qualification == nil || *session.Qualification || session.DiagnosticPosts != 1 || session.RestorePosts != 1 || session.Updates != 2 || session.Timeout != 10000 || session.Observe != 10000 || session.Run != 120000 || session.Builds == nil || *session.Builds != 0 || session.Pushes == nil || *session.Pushes != 0 || session.Production == nil || *session.Production || !session.Paused {
		return nil, denied
	}
	start, e1 := time.Parse(time.RFC3339Nano, session.Started)
	end, e2 := time.Parse(time.RFC3339Nano, session.Deadline)
	baseline, e3 := canonical(session.Baseline)
	candidate, e4 := canonical(session.Candidate)
	if e1 != nil || e2 != nil || e3 != nil || e4 != nil || end.Sub(start) != 15*time.Minute || time.Now().Before(start) || !time.Now().Before(end) || !regexp.MustCompile(`^[A-Za-z0-9-]{1,80}$`).MatchString(session.BaselineVersion) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(session.Owner) || !stoppedBaselineHardOff(baseline) || !frozenBaseline(baseline, session.BaselineImage) || !boundConfig(candidate, baseline, session.Source, session.Image, session.Nonce, session.Owner, start, end) || bytes.Equal(baseline, candidate) || hash(candidate) != session.CandidateDigest || len(packet.Configs) != 2 {
		return nil, denied
	}
	// Only the frozen watchdog configuration is admitted; no preparation variant.
	var config struct {
		Env map[string]string `json:"env"`
	}
	json.Unmarshal(candidate, &config)
	if config.Env["SQLITE_PATH"] != "/data/p10b-first-mailbox-watchdog-"+session.Nonce+".sqlite" || !strings.Contains(config.Env["P10B_GUEST_WINDOW"], `"phase":"prepare"`) {
		return nil, denied
	}
	first, _ := canonical(packet.Configs[0])
	second, _ := canonical(packet.Configs[1])
	if !bytes.Equal(first, baseline) || !bytes.Equal(second, candidate) {
		return nil, denied
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	builder, err := factory(ctx)
	if err != nil {
		return nil, errors.New("Stopped diagnostic authentication unavailable")
	}
	if cutoff := time.Now().Add(120 * time.Second); cutoff.Before(end) {
		end = cutoff
	}
	s := &service{builder: builder, client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect denied") }}, deadline: end, readOnly: packet.ReadOnly, allowedConfig: map[string]bool{hash(baseline): true, hash(candidate): true}, source: session.Source, image: session.Image}
	enableStoppedDiagnostic(s, baseline, candidate, session.BaselineVersion)
	return s, nil
}
func serveStoppedDiagnostic(input io.Reader, output io.Writer, factory func(context.Context) (requestBuilder, error)) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 131072)
	if !scanner.Scan() {
		return errors.New("Stopped diagnostic initialization missing")
	}
	s, err := initializeStoppedDiagnostic(scanner.Bytes(), factory)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(output)
	if encoder.Encode(map[string]interface{}{"version": "p10b-stopped-native-ready-v1", "ready": true}) != nil {
		return errors.New("Stopped diagnostic output failed")
	}
	previous := 0
	for scanner.Scan() {
		var r request
		if strict(scanner.Bytes(), &r) != nil || r.ID <= previous {
			return errors.New("Stopped diagnostic input denied")
		}
		previous = r.ID
		if encoder.Encode(s.request(context.Background(), r)) != nil {
			return errors.New("Stopped diagnostic output failed")
		}
	}
	return scanner.Err()
}
