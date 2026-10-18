package main

// Compiled test-only adapter. Production cannot select another URL or invoke
// this synthetic-token transport. No credential/header reaches the local API.
import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"testing"
)

type logLoopbackHTTP struct {
	base   string
	client *http.Client
}

func (t *logLoopbackHTTP) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.String() != logEndpoint || r.Method != "GET" || r.Body != nil || r.GetBody != nil {
		return nil, errors.New("offline log target denied")
	}
	proxy, e := http.NewRequestWithContext(r.Context(), "GET", t.base+r.URL.RequestURI(), nil)
	if e != nil {
		return nil, e
	}
	proxy.Close = true
	return t.client.Do(proxy)
}
func TestOfflineLogTransport(t *testing.T) {
	address := os.Getenv("P10B_LOG_TEST_HTTP_URL")
	if address == "" {
		t.Skip("explicit loopback fake log HTTP required")
	}
	u, e := url.Parse(address)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.RawQuery != "" || u.Path != "" {
		t.Fatal("offline log target denied")
	}
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, DisableCompression: true}
	defer transport.CloseIdleConnections()
	local := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if serveLogs(os.Stdin, os.Stdout, func(context.Context) (doer, error) {
		return newLogHTTP("synthetic-offline-log-only", &logLoopbackHTTP{base: address, client: local})
	}) != nil {
		t.Fatal("offline log transport held")
	}
}
