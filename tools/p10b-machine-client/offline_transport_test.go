package main

// Test-only HTTP boundary for the real stdio service. This is never linked into
// the production helper and never loads an owner's CLI authentication/config.
import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/superfly/fly-go/flaps"
	"github.com/superfly/fly-go/tokens"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

type offlineUpdateHTTP struct {
	mode     string
	config   json.RawMessage
	instance string
	posts    int
}

func (f *offlineUpdateHTTP) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.String() != "https://api.machines.dev/v1"+endpoint {
		panic("offline target drift")
	}
	status := 200
	if req.Method == "POST" {
		f.posts++
		if f.posts != 1 || req.GetBody != nil || req.Header.Get("Content-Type") != "application/json" || req.Header.Get("Idempotency-Key") != "" || req.Header.Get("X-Idempotency-Key") != "" {
			panic("offline mutation replay/contract drift")
		}
		var body struct {
			Config         json.RawMessage `json:"config"`
			CurrentVersion string          `json:"current_version"`
			SkipLaunch     bool            `json:"skip_launch"`
		}
		raw, err := io.ReadAll(req.Body)
		if err != nil || strict(raw, &body) != nil || !body.SkipLaunch || body.CurrentVersion != f.instance {
			panic("offline frozen update drift")
		}
		switch f.mode {
		case "delayed-success":
			timer := time.NewTimer(1100 * time.Millisecond)
			defer timer.Stop()
			select {
			case <-req.Context().Done():
				return nil, req.Context().Err()
			case <-timer.C:
			}
			f.config = body.Config
			f.instance = "offline-next-version"
		case "timeout":
			<-req.Context().Done()
			return nil, req.Context().Err()
		case "http-rejection":
			status = 422
		default:
			panic("offline HTTP mode denied")
		}
	}
	var config map[string]json.RawMessage
	json.Unmarshal(f.config, &config)
	var image string
	json.Unmarshal(config["image"], &image)
	out, _ := json.Marshal(map[string]interface{}{"id": "0803730bd1d7e8", "region": "ewr", "state": "stopped", "instance_id": f.instance, "config": f.config, "image_ref": map[string]string{"digest": strings.Split(image, "@")[1]}})
	if status != 200 {
		out = []byte(`{"error":"synthetic-private-response-canary"}`)
	}
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(out))), Request: req}, nil
}
func TestOfflineUpdateTransport(t *testing.T) {
	mode := os.Getenv("P10B_TEST_HTTP_MODE")
	if mode == "" {
		t.Skip("explicit test-only HTTP fixture required")
	}
	reader := bufio.NewReader(os.Stdin)
	first, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal("offline initialization missing")
	}
	var p initPacket
	if strict([]byte(first), &p) != nil || len(p.Configs) != 2 {
		t.Fatal("offline frozen configs missing")
	}
	t.Setenv("FLY_FLAPS_BASE_URL", "https://api.machines.dev")
	http.DefaultTransport = &offlineUpdateHTTP{mode: mode, config: p.Configs[0], instance: "01M4JAT6MH4TYR585NEJ7BKSP8"}
	err = serve(io.MultiReader(strings.NewReader(first), reader), os.Stdout, func(ctx context.Context) (requestBuilder, error) {
		return flaps.NewWithOptions(ctx, flaps.NewClientOpts{Tokens: tokens.Parse("synthetic-offline-test-only")})
	})
	if err != nil {
		t.Fatal("offline transport held")
	}
}
