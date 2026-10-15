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
	if request.URL.String() != "https://api.machines.dev/v1"+endpoint || (request.Method != "GET" && request.Method != "POST") || request.GetBody != nil || request.Header.Get("Idempotency-Key") != "" || request.Header.Get("X-Idempotency-Key") != "" {
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
	proxy, err := http.NewRequestWithContext(request.Context(), request.Method, t.base+"/v1"+endpoint, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if request.Method == "POST" {
		proxy.Header.Set("Content-Type", "application/json")
	}
	return t.client.Do(proxy)
}
func TestOfflineStoppedDiagnosticTransport(t *testing.T) {
	address := os.Getenv("P10B_DIAGNOSTIC_TEST_HTTP_URL")
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
	if serveStoppedDiagnostic(io.MultiReader(strings.NewReader(first), reader), os.Stdout, func(ctx context.Context) (requestBuilder, error) {
		return flaps.NewWithOptions(ctx, flaps.NewClientOpts{Tokens: tokens.Parse("synthetic-stopped-diagnostic-only")})
	}) != nil {
		t.Fatal("offline diagnostic held")
	}
}
