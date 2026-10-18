package main

// Test executable only: no production environment variable can select a URL.
// Both fixed SDK-authenticated read routes map to an owned synthetic localhost
// server, with opaque synthetic authentication removed before forwarding.
import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"testing"
)

type stoppedLogProbeLoopbackHTTP struct {
	base   string
	client *http.Client
}

func (t *stoppedLogProbeLoopbackHTTP) RoundTrip(r *http.Request) (*http.Response, error) {
	if (r.URL.String() != stoppedLogProbeMachineEndpoint && r.URL.String() != logEndpoint) || r.Method != "GET" || r.Body != nil || r.GetBody != nil {
		return nil, errors.New("offline probe target denied")
	}
	proxy, e := http.NewRequestWithContext(r.Context(), "GET", t.base+r.URL.RequestURI(), nil)
	if e != nil {
		return nil, e
	}
	proxy.Close = true
	return t.client.Do(proxy)
}
func TestOfflineStoppedLogProbeTransport(t *testing.T) {
	address := os.Getenv("P10B_STOPPED_LOG_PROBE_TEST_HTTP_URL")
	if address == "" {
		t.Skip("explicit owned loopback probe HTTP required")
	}
	u, e := url.Parse(address)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.RawQuery != "" || u.Path != "" {
		t.Fatal("offline probe target denied")
	}
	transport := restrictedLogTransport()
	defer transport.CloseIdleConnections()
	local := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if e := serveStoppedLogProbe(context.Background(), os.Stdin, os.Stdout, func(context.Context) (doer, error) {
		return newStoppedLogProbeHTTP("synthetic-offline-probe-only", &stoppedLogProbeLoopbackHTTP{base: address, client: local})
	}); e != nil {
		t.Fatal("offline probe held")
	}
}
