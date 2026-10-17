//go:build p10b_stopped_log_probe && !p10b_stopped_diagnostic

package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) != 2 || os.Args[1] != "--serve-stopped-log-probe" {
		fmt.Fprintln(os.Stderr, "Stopped log probe requires its separate read-only approval.")
		os.Exit(1)
	}
	if runStoppedLogProbeMain() != nil {
		fmt.Fprintln(os.Stderr, "Stopped log probe held; retain public evidence.")
		os.Exit(1)
	}
}
