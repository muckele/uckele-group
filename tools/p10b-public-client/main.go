// Separate read-only names selection and local registry config writer. The
// retained Machine mutation helper is unchanged. Only Fly SDK owns token syntax.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"syscall"
	"time"

	fly "github.com/superfly/fly-go"
	"github.com/superfly/fly-go/tokens"
	"github.com/superfly/graphql"
)

// Supported by flyctl v0.4.115 gql AppData's secrets { name } fragment.
const namesQuery = `query { app(name: "uckele-group-p10b") { secrets { name } } }`

var denied = errors.New("bounded public client denied")

type namesResponse struct {
	Data struct {
		App *struct {
			Secrets []struct {
				Name string `json:"name"`
			} `json:"secrets"`
		} `json:"app"`
	} `json:"data"`
}
type closedResponse struct{ next http.RoundTripper }

func (c closedResponse) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.String() != "https://api.fly.io/graphql" || r.Method != "POST" {
		return nil, denied
	}
	response, err := c.next.RoundTrip(r)
	if err != nil {
		return nil, denied
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, denied
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 {
		return nil, denied
	}
	var decoded namesResponse
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&decoded) != nil || decoder.Decode(new(interface{})) != io.EOF || decoded.Data.App == nil {
		return nil, denied
	}
	// Unknown fields fail before any hash/output. SDK sees only admitted names.
	if len(decoded.Data.App.Secrets) > 32 {
		return nil, denied
	}
	names := map[string]bool{}
	for _, s := range decoded.Data.App.Secrets {
		if !regexp.MustCompile(`^[A-Z0-9_]{1,120}$`).MatchString(s.Name) || names[s.Name] || s.Name == "RESEND_API_KEY" || s.Name == "EMAIL_WEBHOOK_SECRET" {
			return nil, denied
		}
		names[s.Name] = true
	}
	admitted, err := json.Marshal(decoded)
	if err != nil {
		return nil, denied
	}
	response.Body = io.NopCloser(bytes.NewReader(admitted))
	response.ContentLength = int64(len(admitted))
	return response, nil
}
func secretNames(ctx context.Context, token string, next http.RoundTripper) ([]string, error) {
	auth := &fly.Transport{Token: token, UnderlyingTransport: closedResponse{next: next}, UserAgent: "p10b-names-only/1"}
	client := graphql.NewClient("https://api.fly.io/graphql", graphql.WithHTTPClient(&http.Client{Transport: auth, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return denied }}))
	var data struct {
		App *struct {
			Secrets []struct {
				Name string `json:"name"`
			} `json:"secrets"`
		} `json:"app"`
	}
	if err := client.Run(ctx, graphql.NewRequest(namesQuery), &data); err != nil || data.App == nil {
		return nil, denied
	}
	names := make([]string, 0, len(data.App.Secrets))
	for _, s := range data.App.Secrets {
		names = append(names, s.Name)
	}
	sort.Strings(names)
	return names, nil
}
func writeDockerConfig(directory, token string) error {
	stat, err := os.Lstat(directory)
	if err != nil || !stat.IsDir() || stat.Mode().Perm() != 0700 {
		return denied
	}
	owner, ok := stat.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) {
		return denied
	}
	// Mirrors flyctl's normal Docker auth representation; never emits credential.
	auth := base64.StdEncoding.EncodeToString([]byte("x:" + tokens.Parse(token).Docker()))
	payload, err := json.Marshal(map[string]interface{}{"auths": map[string]interface{}{"registry.fly.io": map[string]string{"auth": auth}}})
	if err != nil {
		return denied
	}
	file, err := os.OpenFile(filepath.Join(directory, "config.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return denied
	}
	defer file.Close()
	if _, err = file.Write(payload); err != nil {
		return denied
	}
	return file.Sync()
}
func run() error {
	if len(os.Args) != 2 || len(os.Getenv("FLY_API_TOKEN")) == 0 || len(os.Getenv("FLY_API_TOKEN")) > 16384 {
		return denied
	}
	switch os.Args[1] {
	case "--secret-names":
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		transport := &http.Transport{Proxy: nil, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 5 * time.Second}
		defer transport.CloseIdleConnections()
		names, err := secretNames(ctx, os.Getenv("FLY_API_TOKEN"), transport)
		if err != nil {
			return denied
		}
		return json.NewEncoder(os.Stdout).Encode(names)
	case "--registry-config":
		return writeDockerConfig(os.Getenv("DOCKER_CONFIG"), os.Getenv("FLY_API_TOKEN"))
	default:
		return denied
	}
}
func main() {
	if run() != nil {
		os.Stderr.WriteString("Bounded public client held.\n")
		os.Exit(1)
	}
}
