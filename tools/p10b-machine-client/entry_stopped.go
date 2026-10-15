//go:build p10b_stopped_diagnostic

package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) != 2 || os.Args[1] != "--serve-stopped-update-diagnostic" {
		fmt.Fprintln(os.Stderr, "Stopped diagnostic requires explicit zero-start approval.")
		os.Exit(1)
	}
	if serveStoppedDiagnostic(os.Stdin, os.Stdout, loadClient) != nil {
		fmt.Fprintln(os.Stderr, "Stopped diagnostic held; retain public evidence.")
		os.Exit(1)
	}
}
