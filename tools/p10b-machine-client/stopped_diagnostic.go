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
	lastStopped, lastNonrunning          bool
	lastAt                               time.Time
	primaryAttempted, restoreAttempted   bool
	primaryVersion, restoreVersion       string
	primaryWait, restoreWait             bool
	primarySettled, restoreSettled       bool
	phaseDeadline                        time.Time
	hold                                 bool
	guardian, primaryReadback            bool
}
type stoppedSettlement struct {
	OK      bool   `json:"ok"`
	State   string `json:"state"`
	Version string `json:"version"`
}

func stoppedImageMatches(m map[string]json.RawMessage) bool {
	var config struct {
		Image string `json:"image"`
	}
	var image struct {
		Digest string `json:"digest"`
	}
	if json.Unmarshal(m["config"], &config) != nil || json.Unmarshal(m["image_ref"], &image) != nil {
		return false
	}
	_, digest, ok := strings.Cut(config.Image, "@")
	return ok && digest == image.Digest
}

func enableStoppedDiagnostic(s *service, baseline, candidate []byte, version string) {
	s.diagnostic = &stoppedDiagnosticPolicy{baseline: hash(baseline), candidate: hash(candidate), baselineVersion: version}
}
func (d *stoppedDiagnosticPolicy) writeAllowed(posts int, config, version string) bool {
	if d.hold || time.Since(d.lastAt) > time.Second || version != d.lastVersion {
		return false
	}
	if posts == 0 {
		return !d.primaryAttempted && d.lastStopped && config == d.candidate && d.lastConfig == d.baseline && version == d.baselineVersion
	}
	settlementEligible := !d.phaseDeadline.IsZero() && time.Now().Before(d.phaseDeadline) && d.lastNonrunning
	if d.guardian {
		settlementEligible = d.primaryReadback && d.lastStopped
	}
	return posts == 1 && !d.restoreAttempted && d.primaryVersion != "" && d.primarySettled && settlementEligible && config == d.baseline && d.lastConfig == d.candidate && version == d.primaryVersion
}
func (d *stoppedDiagnosticPolicy) beginWrite(posts int) {
	if posts == 0 {
		d.primaryAttempted = true
	} else {
		d.restoreAttempted = true
	}
	d.lastAt = time.Time{}
}
func (d *stoppedDiagnosticPolicy) acknowledge(posts int, m map[string]json.RawMessage) bool {
	var state, version string
	json.Unmarshal(m["state"], &state)
	json.Unmarshal(m["instance_id"], &version)
	config, _ := canonical(m["config"])
	if d.hold || !map[string]bool{"created": true, "stopped": true, "replacing": true}[state] {
		return false
	}
	if posts == 1 && hash(config) == d.candidate && version != d.baselineVersion {
		d.primaryVersion = version
		if d.guardian {
			d.phaseDeadline = time.Now().Add(10 * time.Second)
		}
		return true
	}
	if posts == 2 && hash(config) == d.baseline && version != d.primaryVersion && version != d.baselineVersion {
		d.restoreVersion = version
		if d.guardian {
			d.phaseDeadline = time.Now().Add(10 * time.Second)
		}
		return true
	}
	return false
}
func (d *stoppedDiagnosticPolicy) beginWait(version string) bool {
	if d.hold {
		return false
	}
	if d.restoreAttempted {
		if d.restoreVersion == "" || version != d.restoreVersion || d.restoreWait {
			return false
		}
		d.restoreWait = true
	} else {
		if d.primaryVersion == "" || version != d.primaryVersion || d.primaryWait {
			return false
		}
		d.primaryWait = true
	}
	d.lastAt = time.Time{}
	if !d.guardian {
		d.phaseDeadline = time.Now().Add(10 * time.Second)
	}
	if d.phaseDeadline.IsZero() || !time.Now().Before(d.phaseDeadline) {
		d.hold = true
		return false
	}
	return true
}
func (d *stoppedDiagnosticPolicy) settlement(raw []byte, version string) (*stoppedSettlement, error) {
	var wire struct {
		OK      *bool           `json:"ok"`
		State   string          `json:"state"`
		Version string          `json:"version"`
		EventID json.RawMessage `json:"event_id"`
	}
	if !uniqueStoppedObject(raw) || strict(raw, &wire) != nil || wire.OK == nil || !*wire.OK || wire.Version != version || (wire.State != "created" && wire.State != "stopped") {
		return nil, errors.New("invalid-output")
	}
	return &stoppedSettlement{OK: true, State: wire.State, Version: wire.Version}, nil
}
func uniqueStoppedObject(raw []byte) bool {
	d := json.NewDecoder(bytes.NewReader(raw))
	first, err := d.Token()
	if err != nil || first != json.Delim('{') {
		return false
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := d.Token()
		name, ok := key.(string)
		if err != nil || !ok || seen[name] {
			return false
		}
		seen[name] = true
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return false
		}
	}
	last, err := d.Token()
	return err == nil && last == json.Delim('}') && d.Decode(new(interface{})) == io.EOF
}
func (d *stoppedDiagnosticPolicy) finishWait() bool {
	if d.phaseDeadline.IsZero() || !time.Now().Before(d.phaseDeadline) {
		return false
	}
	if d.restoreAttempted {
		d.restoreSettled = true
	} else {
		d.primarySettled = true
	}
	// Only a fresh exact GET after this successful wait may authorize a write.
	d.lastAt = time.Time{}
	return true
}
func (d *stoppedDiagnosticPolicy) phaseAllows(method string) bool {
	if d.phaseDeadline.IsZero() {
		return method != "WAIT"
	}
	return time.Now().Before(d.phaseDeadline)
}
func (d *stoppedDiagnosticPolicy) observe(m map[string]json.RawMessage) bool {
	var state, version string
	json.Unmarshal(m["state"], &state)
	json.Unmarshal(m["instance_id"], &version)
	config, _ := canonical(m["config"])
	if !d.phaseAllows("GET") {
		d.hold = true
		return false
	}
	if d.primaryAttempted {
		// Reads remain available for uncertain remote-state evidence, but can
		// never convert a failed/missing acknowledgement into write authority.
		if d.hold || d.primaryVersion == "" || (d.restoreAttempted && d.restoreVersion == "") {
			return true
		}
		wantConfig, wantVersion := d.candidate, d.primaryVersion
		if d.restoreAttempted {
			wantConfig, wantVersion = d.baseline, d.restoreVersion
		}
		stateAllowed := state == "created" || state == "stopped"
		if d.guardian && d.primaryReadback && !d.restoreAttempted {
			stateAllowed = map[string]bool{"created": true, "stopped": true, "starting": true, "started": true, "stopping": true}[state]
		}
		if hash(config) != wantConfig || version != wantVersion || !stateAllowed {
			d.hold = true
			return false
		}
	} else if hash(config) != d.baseline || version != d.baselineVersion || state != "stopped" {
		d.hold = true
		return false
	}
	if d.guardian && state == "stopped" && ((d.primarySettled && !d.restoreAttempted) || d.restoreSettled) {
		d.primaryReadback = true
		d.phaseDeadline = time.Time{}
	}
	d.lastConfig, d.lastVersion = hash(config), version
	d.lastStopped = state == "stopped"
	d.lastNonrunning = state == "created" || state == "stopped"
	d.lastAt = time.Now()
	return true
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
		RecoveryPolicy  string          `json:"recoveryPolicy"`
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
	if json.Unmarshal([]byte(packet.SessionCanonical), &session) != nil || session.Version != "p10b-stopped-update-session-v2" || session.Operation != "stopped-update-diagnostic" || session.RecoveryPolicy != "acknowledged-only-nonrunning-v1" || session.App != "uckele-group-p10b" || session.Machine != "0803730bd1d7e8" || session.Volume != "vol_vwnkpex1k3yx9dnv" || session.Source != "c4944a46ac362cdcd002e077d5533b4b0843b1d0" || session.Image != "sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc" || session.BaselineImage != "sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629" || session.Starts == nil || *session.Starts != 0 || session.Window == nil || *session.Window != 0 || session.Qualification == nil || *session.Qualification || session.DiagnosticPosts != 1 || session.RestorePosts != 1 || session.Updates != 2 || session.Timeout != 10000 || session.Observe != 10000 || session.Run != 120000 || session.Builds == nil || *session.Builds != 0 || session.Pushes == nil || *session.Pushes != 0 || session.Production == nil || *session.Production || !session.Paused {
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
