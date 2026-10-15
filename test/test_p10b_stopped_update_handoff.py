"""Actual diagnostic TTY and production preflight; external runtime is simulated."""
import unittest
import test_p10b_consolidated_handoff as consolidated

class StoppedDiagnosticTTYTests(consolidated.RealComponentTTYTests):
    diagnostic_mode = True

    def test_old_stopped_update_phrase_cannot_approve_conditional_recovery(self):
        self.run_journey('old-diagnostic-consent')

if __name__ == '__main__':
    unittest.main()
