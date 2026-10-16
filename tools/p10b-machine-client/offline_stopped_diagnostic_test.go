package main

// Test-only proxy to a parent-owned loopback fake API. SDK authentication is
// synthetic and never forwarded; no production binary links this transport.
import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/superfly/fly-go/flaps"
	"github.com/superfly/fly-go/tokens"
)

type diagnosticLoopbackHTTP struct {
	base   string
	client *http.Client
}

func (t *diagnosticLoopbackHTTP) RoundTrip(request *http.Request) (*http.Response, error) {
	ordinary := request.URL.String() == "https://api.machines.dev/v1"+endpoint && (request.Method == "GET" || request.Method == "POST")
	wait := request.Method == "GET" && request.URL.Scheme == "https" && request.URL.Host == "api.machines.dev" && request.URL.Path == "/v1"+endpoint+"/wait" && request.URL.User == nil && request.URL.Fragment == "" && regexp.MustCompile(`^state=settled&timeout=[1-9]&version=[A-Za-z0-9-]{1,80}$`).MatchString(request.URL.RawQuery)
	if (!ordinary && !wait) || request.GetBody != nil || request.Header.Get("Idempotency-Key") != "" || request.Header.Get("X-Idempotency-Key") != "" {
		return nil, errors.New("offline endpoint denied")
	}
	var data []byte
	if request.Body != nil {
		var err error
		data, err = io.ReadAll(io.LimitReader(request.Body, 131072))
		if err != nil || len(data) >= 131072 {
			return nil, errors.New("offline body bound")
		}
	}
	proxy, err := http.NewRequestWithContext(request.Context(), request.Method, t.base+request.URL.RequestURI(), bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if request.Method == "POST" {
		proxy.Header.Set("Content-Type", "application/json")
	}
	return t.client.Do(proxy)
}
func TestOfflineStoppedDiagnosticTransport(t *testing.T) {
	offlineLoopbackTransport(t, "P10B_DIAGNOSTIC_TEST_HTTP_URL", serveStoppedDiagnostic)
}
func TestOfflineGuardianTransport(t *testing.T) {
	offlineLoopbackTransport(t, "P10B_GUARDIAN_TEST_HTTP_URL", serve)
}
func offlineLoopbackTransport(t *testing.T, variable string, serveSession func(io.Reader, io.Writer, func(context.Context) (requestBuilder, error)) error) {
	address := os.Getenv(variable)
	if address == "" {
		t.Skip("explicit loopback fake HTTP required")
	}
	parsed, err := url.Parse(address)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Port() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Path != "" {
		t.Fatal("offline transport target denied")
	}
	reader := bufio.NewReader(os.Stdin)
	first, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal("offline input missing")
	}
	t.Setenv("FLY_FLAPS_BASE_URL", "https://api.machines.dev")
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	http.DefaultTransport = &diagnosticLoopbackHTTP{base: address, client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("offline redirect denied") }}}
	if serveSession(io.MultiReader(strings.NewReader(first), reader), os.Stdout, func(ctx context.Context) (requestBuilder, error) {
		return flaps.NewWithOptions(ctx, flaps.NewClientOpts{Tokens: tokens.Parse("synthetic-stopped-diagnostic-only")})
	}) != nil {
		t.Fatal("offline diagnostic held")
	}
}
