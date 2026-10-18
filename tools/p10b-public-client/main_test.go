package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type stubTransport func(*http.Request) (*http.Response, error)

func (f stubTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestSDKRequestsNamesExclusively(t *testing.T) {
	calls := 0
	names, err := secretNames(context.Background(), "offline-opaque", stubTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		b, _ := io.ReadAll(r.Body)
		var input struct {
			Query     string                 `json:"query"`
			Variables map[string]interface{} `json:"variables"`
		}
		if json.Unmarshal(b, &input) != nil || input.Query != namesQuery || len(input.Variables) != 0 || strings.Contains(input.Query, "digest") || r.URL.String() != "https://api.fly.io/graphql" || r.Method != "POST" {
			t.Fatal("fixed names-exclusive selection required")
		}
		if r.Header.Get("Authorization") != "Bearer offline-opaque" {
			t.Fatal("normal SDK authentication required")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"data":{"app":{"secrets":[{"name":"B_KEY"},{"name":"A_KEY"}]}}}`)), Header: make(http.Header)}, nil
	}))
	if err != nil || strings.Join(names, ",") != "A_KEY,B_KEY" || calls != 1 {
		t.Fatal("names-exclusive response failed")
	}
}
func TestUnexpectedProviderFieldsHoldWithoutHashing(t *testing.T) {
	for _, raw := range []string{`{"data":{"app":{"secrets":[{"name":"A_KEY","digest":"abc123"}]}}}`, `{"data":{"app":{"secrets":[{"name":"A_KEY"},{"name":"A_KEY"}]}}}`, `{"data":{"app":{"secrets":[{"name":"RESEND_API_KEY"}]}}}`, `{"data":{"app":null}}`, `{"data":{"app":{"secrets":[]}}} trailing`, strings.Repeat("x", 65537)} {
		names, err := secretNames(context.Background(), "offline-opaque", stubTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(raw)), Header: make(http.Header)}, nil
		}))
		if err == nil || names != nil {
			t.Fatal("unexpected response must hold")
		}
	}
}
func TestPrivateDockerConfigUsesSameOpaqueSDKTokenNoHelpers(t *testing.T) {
	root := t.TempDir()
	os.Chmod(root, 0700)
	if err := writeDockerConfig(root, "FlyV1 fm2_offline"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(root, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c map[string]json.RawMessage
	json.Unmarshal(b, &c)
	if len(c) != 1 || c["auths"] == nil || strings.Contains(string(b), "credsStore") || strings.Contains(string(b), "credHelpers") {
		t.Fatal("isolated file auth only")
	}
	if err := writeDockerConfig(root, "FlyV1 fm2_offline"); err == nil {
		t.Fatal("existing state must not be overwritten")
	}
	os.Chmod(root, 0755)
	if err := writeDockerConfig(root, "offline"); err == nil {
		t.Fatal("private directory required")
	}
}
