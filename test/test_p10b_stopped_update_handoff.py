"""Actual diagnostic TTY and production preflight; external runtime is simulated."""
import unittest
import test_p10b_consolidated_handoff as consolidated

class StoppedDiagnosticTTYTests(consolidated.RealComponentTTYTests):
    diagnostic_mode = True

if __name__ == '__main__':
    unittest.main()
