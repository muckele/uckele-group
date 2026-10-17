"""Closed owner reports through real bounded child exit; no authenticated clients."""
import copy
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import test_p10b_owner_handoff as legacy

handoff = legacy.handoff

def report():
    return {'version': 'p10b-stopped-update-operator-report-v1', 'sessionDigest': 'a' * 64,
            'outcome': 'held', 'failedStep': 'diagnostic-write', 'category': 'timeout',
            'httpStatus': None, 'requestMethod': 'POST', 'dispatched': True,
            'serverState': 'uncertain-after-request', 'lastObservedAt': '2026-10-16T00:00:00.000Z',
            'restorationVerified': False, 'clientsClosed': True, 'privateCleanup': 'verified', 'localClosureIssue': None,
            'nextAction': 'preserve-for-independent-review', 'automaticRetryAllowed': False,
            'automaticRecoveryAllowed': False, 'newCredentialAuthorized': False,
            'productionReady': False, 'globalAutomationPaused': True, 'providerCalls': 0, 'emails': 0}

class DiagnosticReportTests(unittest.TestCase):
    def test_closed_report_rejects_unknown_fields_bad_types_and_wrong_session(self):
        self.assertEqual(handoff.checked_diagnostic_report(report(), 'a' * 64), report())
        for change in [lambda r: r.update(raw='PRIVATE_CANARY'), lambda r: r.update(httpStatus=True),
                       lambda r: r.update(category='PRIVATE_CANARY'), lambda r: r.update(lastObservedAt='PRIVATE_CANARY'),
                       lambda r: r.update(automaticRetryAllowed=True), lambda r: r.update(providerCalls=False),
                       lambda r: r.update(sessionDigest='b' * 64), lambda r: r.update(nextAction='PRIVATE_CANARY'),
                       lambda r: r.update(outcome='succeeded', failedStep=None, category='none',
                           nextAction='manually-revoke-matching-token-after-closed-clients', restorationVerified=False),
                       lambda r: r.update(clientsClosed=False, localClosureIssue=None),
                       lambda r: r.update(nextAction='manually-revoke-matching-token-after-closed-clients')]:
            bad = copy.deepcopy(report()); change(bad)
            with self.assertRaises(handoff.Hold): handoff.checked_diagnostic_report(bad, 'a' * 64)

    def test_actual_nonzero_child_retains_only_closed_summary_after_settlement(self):
        with tempfile.TemporaryDirectory(prefix='p10b-report-') as directory:
            scripts = Path(directory)
            script = scripts / 'run-p10b-stopped-update-diagnostic.js'
            script.write_text('process.stdout.write(' + json.dumps(json.dumps({'operatorReport': report(), 'raw': 'PRIVATE_CANARY'})) + ');process.exitCode=1;')
            with patch.object(handoff, 'SCRIPTS', scripts):
                with self.assertRaises(handoff.DiagnosticHold) as held:
                    handoff.run_command([shutil.which('node'), str(script)], {'PATH': '/usr/bin:/bin', 'HOME': directory}, 5)
            self.assertEqual(held.exception.report, report())
            self.assertNotIn('CANARY', str(held.exception))
            self.assertNotIn('CANARY', json.dumps(held.exception.report))

    def test_actual_nonzero_child_unknown_report_is_generic_hold(self):
        with tempfile.TemporaryDirectory(prefix='p10b-report-') as directory:
            scripts = Path(directory); script = scripts / 'run-p10b-stopped-update-diagnostic.js'
            bad = report(); bad['raw'] = 'PRIVATE_CANARY'
            script.write_text('process.stdout.write(' + json.dumps(json.dumps({'operatorReport': bad})) + ');process.exitCode=1;')
            with patch.object(handoff, 'SCRIPTS', scripts):
                with self.assertRaises(handoff.Hold) as held:
                    handoff.run_command([shutil.which('node'), str(script)], {'PATH': '/usr/bin:/bin', 'HOME': directory}, 5)
            self.assertNotIsInstance(held.exception, handoff.DiagnosticHold)
            self.assertNotIn('CANARY', str(held.exception))


    def test_nonzero_child_cannot_report_success_even_with_consistent_closed_fields(self):
        succeeded = report()
        succeeded.update(outcome='succeeded', failedStep=None, category='none', requestMethod=None, dispatched=None,
                         restorationVerified=True, serverState='last-observed-baseline-nonrunning',
                         nextAction='manually-revoke-matching-token-after-closed-clients')
        self.assertEqual(handoff.checked_diagnostic_report(succeeded), succeeded)
        with tempfile.TemporaryDirectory(prefix='p10b-report-') as directory:
            scripts = Path(directory); script = scripts / 'run-p10b-stopped-update-diagnostic.js'
            script.write_text('process.stdout.write(' + json.dumps(json.dumps({'operatorReport': succeeded})) + ');process.exitCode=1;')
            with patch.object(handoff, 'SCRIPTS', scripts):
                with self.assertRaises(handoff.Hold) as held:
                    handoff.run_command([shutil.which('node'), str(script)], {'PATH': '/usr/bin:/bin', 'HOME': directory}, 5)
            self.assertNotIsInstance(held.exception, handoff.DiagnosticHold)


class OwnerReportBindingTests(unittest.TestCase):
    def test_private_owner_console_emits_only_session_bound_report_or_safe_fallback(self):
        import re
        import test_p10b_consolidated_handoff as consolidated
        for mismatch in (False, True):
            with self.subTest(mismatch=mismatch):
                journey = consolidated.RealComponentTTYTests()
                journey.diagnostic_mode = True
                journey.setUp()
                try:
                    source = journey.driver.read_text()
                    source = source.replace(' result=h.run_command([node,helper,mode,str(root)],environment,timeout)',
                        " if mode=='--execute':\n  report=json.loads((root/'report-fixture.json').read_text())\n  if report['sessionDigest'] is None:\n   report['sessionDigest']=json.loads((root/'approved-session.json').read_text())['approval']['sessionDigest']\n  raise h.DiagnosticHold(report)\n result=h.run_command([node,helper,mode,str(root)],environment,timeout)")
                    journey.driver.write_text(source)
                    fixture = report(); fixture['sessionDigest'] = 'b' * 64 if mismatch else None
                    (journey.root / 'report-fixture.json').write_text(json.dumps(fixture))
                    child = journey.launch([handoff.sys.executable, str(journey.driver), str(legacy.SOURCE), str(journey.root), journey.node, str(journey.helper)])
                    output = journey.until(child, b'APPROVE PRIVATE SETUP ')
                    digest = re.findall(rb'APPROVE PRIVATE SETUP ([a-f0-9]{64})', output)[-1]
                    legacy.os.write(child[1], b'APPROVE PRIVATE SETUP ' + digest + b'\n')
                    journey.until(child, b'Type PUBLIC RECORD READY')
                    journey.owner_issue_synthetic_once()
                    legacy.os.write(child[1], b'PUBLIC RECORD READY\n')
                    output = journey.until(child, b' to attest successful owner issuance')
                    digest = re.findall(rb'CONFIRM PUBLIC FACTS ([a-f0-9]{64})', output)[-1]
                    legacy.os.write(child[1], b'CONFIRM PUBLIC FACTS ' + digest + b'\n')
                    journey.until(child, b'Temporary isolated app token (hidden): ')
                    legacy.os.write(child[1], journey.secret.encode() + b'\n')
                    output = journey.until(child, b' to authorize this exact ')
                    digest = re.findall(rb'APPROVE CONDITIONAL STOPPED UPDATE ([a-f0-9]{64})', output)[-1]
                    legacy.os.write(child[1], b'APPROVE CONDITIONAL STOPPED UPDATE ' + digest + b'\n')
                    code, output = journey.drain(child)
                    self.assertEqual(code, 2, output[-3000:])
                    terminal = handoff.read_public(journey.root / 'owner-terminal.json')
                    safe = terminal['operatorReport']
                    self.assertEqual(safe['sessionDigest'], digest.decode())
                    self.assertEqual(safe['category'], 'validation-or-unclassified' if mismatch else 'timeout')
                    self.assertEqual(safe['privateCleanup'], 'unverified' if mismatch else 'verified')
                    self.assertIn(b'operatorReport', output)
                    self.assertNotIn(journey.secret.encode(), output)
                    self.assertNotIn(b'b' * 64, output.split(b'\"operatorReport\":', 1)[1])
                    self.assertFalse(safe['automaticRetryAllowed'])
                finally: journey.doCleanups()

if __name__ == '__main__': unittest.main()
