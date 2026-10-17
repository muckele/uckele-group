"""Guardian-only owner consent and sealed bounds; all external work is fake."""
import hashlib
import json
from pathlib import Path
import unittest
import test_p10b_owner_handoff as legacy

handoff = legacy.handoff

class GuardianOwnerTests(unittest.TestCase):
    def setUp(self):
        self.f = legacy.OwnerEntryTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.f.recipe['version'] = 'p10b-owner-guardian-only-recipe-v1'
        self.f.recipe['files']['guardianNative'] = {'path': '/offline/guardian-native', 'sha256': 'f' * 64}
        self.f.recipe_path.write_text(handoff.canonical(self.f.recipe) + '\n')
        self.messages, self.prompts, self.mode = [], [], ''

    def ask(self, prompt):
        self.prompts.append(prompt)
        if 'APPROVE ONE GUARDIAN START ' in prompt:
            return ('APPROVE SESSION ' if self.mode == 'legacy-consent' else 'APPROVE ONE GUARDIAN START ') + self.f.summary['sessionDigest']
        return self.f.ask(prompt)

    def runner(self, args, env, timeout):
        f = self.f
        if '--check-only' in args:
            result = f.runner(args, env, timeout)
            result.update(operation='guardian-only', maximumStarts=1, maximumStartWindowMs=300000,
                          maximumStoppedConfigUpdates=2, maximumLocalBuilds=0, maximumImagePushes=0,
                          qualificationAllowed=False, recoveryPolicy='acknowledged-only-stopped-runtime-v1')
            if self.mode == 'static-escalation': result['maximumStarts'] = 2
            if self.mode == 'static-bool-starts': result['maximumStarts'] = True
            return result
        if '--prepare' in args:
            f.calls.append((args, dict(env), timeout))
            now = handoff.utc_now()
            session = {'version': 'p10b-guardian-only-session-v1', 'operation': 'guardian-only',
                'qualificationAllowed': False, 'recoveryPolicy': 'acknowledged-only-stopped-runtime-v1',
                'hostSourceHead': f.recipe['hostSourceHead'], 'sourceHead': 'c4944a46ac362cdcd002e077d5533b4b0843b1d0',
                'startedAt': now, 'sessionDeadline': handoff.utc_after(now, 3600),
                'maximumStarts': 1, 'maximumStartWindowMs': 300000, 'maximumStoppedConfigUpdates': 2,
                'maximumLocalBuilds': 0, 'maximumImagePushes': 0,
                'nativeClientSha256': f.recipe['files']['guardianNative']['sha256'],
                'productionReady': False, 'globalAutomationPaused': True, 'ownerPermissionDigest': 'd' * 64}
            if self.mode in ('starts', 'builds', 'pushes', 'updates', 'window'):
                session[{'starts': 'maximumStarts', 'builds': 'maximumLocalBuilds', 'pushes': 'maximumImagePushes',
                         'updates': 'maximumStoppedConfigUpdates', 'window': 'maximumStartWindowMs'}[self.mode]] += 1
            if self.mode == 'wrong-native': session['nativeClientSha256'] = 'a' * 64
            if self.mode == 'qualification': session['qualificationAllowed'] = True
            if self.mode == 'old-policy': session['recoveryPolicy'] = 'legacy'
            if self.mode == 'long-session': session['sessionDeadline'] = handoff.utc_after(now, 7200)
            canonical = handoff.canonical(session)
            digest = hashlib.sha256(canonical.encode()).hexdigest()
            bundle = {'version': 'p10b-guardian-only-bundle-v1', 'status': 'AWAITING_EXACT_OWNER_APPROVAL',
                'session': session, 'approval': {'version': 'p10b-guardian-only-approval-v1', 'approved': False,
                    'sessionDigest': digest, 'providerCalls': 0, 'emails': 0}, 'imageEvidence': {'buildCount': 1, 'pushCount': 1}}
            if self.mode == 'old-approval': bundle['approval']['version'] = 'p10b-no-email-approval-v1'
            if self.mode == 'already-approved': bundle['approval']['approved'] = True
            if self.mode == 'old-bundle': bundle['version'] = 'p10b-no-email-bundle-v1'
            handoff.write_exclusive(f.recipe['sealedBundlePath'], bundle)
            f.summary = {'status': 'AWAITING_EXACT_OWNER_APPROVAL', 'sessionDigest': digest, 'sessionCanonical': canonical,
                'sessionDeadline': session['sessionDeadline'], 'sealedBundlePath': f.recipe['sealedBundlePath'],
                'sealedBundleSha256': hashlib.sha256(Path(f.recipe['sealedBundlePath']).read_bytes()).hexdigest(),
                'preflightCleanupVerified': True, 'runtimeApproved': False}
            if self.mode == 'summary-cutoff': f.summary['sessionDeadline'] = handoff.utc_after(now, 7200)
            return f.summary
        result = f.runner(args, env, timeout)
        if '--execute' in args:
            result.update(operation='guardian-only', maximumStarts=1, qualificationAllowed=False,
                          restored=True, mutationSettled=True, providerCalls=0, emails=0)
            if self.mode == 'result-escalation': result['qualificationAllowed'] = True
        return result

    def invoke(self):
        f = self.f
        return handoff.run_owner(f.recipe_path, self.runner, self.ask, f.token, lambda: True, self.messages.append,
            expected_recipe_sha256=hashlib.sha256(f.recipe_path.read_bytes()).hexdigest(), bootstrap=lambda _path, _sha: f.recipe)

    def test_guardian_consent_executes_only_guardian_native_and_no_email_cli(self):
        self.assertEqual(self.invoke(), 0)
        approved = handoff.read_public(self.f.recipe['approvedBundlePath'])
        self.assertEqual(approved['status'], 'OWNER_APPROVED_GUARDIAN_ONLY_SESSION')
        self.assertTrue(any('APPROVE ONE GUARDIAN START ' in p for p in self.prompts))
        self.assertFalse(any('APPROVE SESSION ' in p for p in self.prompts))
        text = '\n'.join(self.messages)
        self.assertIn('one inert', text)
        self.assertIn('No preparation', text)
        args = self.f.calls[-1][0]
        self.assertIn('/offline/guardian-native', args)
        self.assertTrue(any(str(x).endswith('run-p10b-no-email-session.js') for x in args))
        self.assertNotIn('/offline/native', args)

    def test_legacy_consent_cannot_authorize_guardian_start(self):
        self.mode = 'legacy-consent'
        self.assertEqual(self.invoke(), 2)
        self.assertFalse(any('--execute' in args for args, _, _ in self.f.calls))

    def test_static_escalation_refuses_before_private_setup(self):
        self.mode = 'static-escalation'
        self.assertEqual(self.invoke(), 2)
        self.assertEqual(self.f.token_calls, 0)
        self.assertFalse((self.f.root / 'private-setup-scope.json').exists())

    def test_sealed_escalation_cannot_reach_consent_or_execution(self):
        for mode in ('starts', 'builds', 'pushes', 'updates', 'window', 'wrong-native', 'qualification', 'old-policy', 'long-session', 'old-approval', 'already-approved', 'old-bundle', 'summary-cutoff'):
            with self.subTest(mode=mode):
                self.setUp(); self.mode = mode
                self.assertEqual(self.invoke(), 2)
                self.assertFalse(any('APPROVE ONE GUARDIAN START ' in p for p in self.prompts))
                self.assertFalse(any('--execute' in args for args, _, _ in self.f.calls))

    def test_result_cannot_promote_qualification(self):
        self.mode = 'result-escalation'
        self.assertEqual(self.invoke(), 2)

import test_p10b_consolidated_handoff as consolidated

class GuardianOwnerTTYTests(consolidated.RealComponentTTYTests):
    guardian_mode = True

    def test_legacy_session_phrase_cannot_approve_guardian_only(self):
        self.run_journey('old-guardian-consent')

if __name__ == '__main__':
    unittest.main()
