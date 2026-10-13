import hashlib
import errno
import importlib.util
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
import tempfile
import unittest
import warnings
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parent.parent / 'scripts/run-p10b-owner-handoff.py'
def fixture_digest(value):
    # Recipe fixture has no floats; actual session/budget uses Node below.
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
handoff = None
if SOURCE.exists():
    spec = importlib.util.spec_from_file_location('owner_handoff', SOURCE)
    handoff = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(handoff)


class OwnerEntryTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(handoff, 'private owner handoff implementation missing')
        self.temporary = tempfile.TemporaryDirectory(prefix='p10b-owner-offline-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.evidence = self.root / 'runtime-evidence'
        self.evidence.mkdir(mode=0o700)
        price_path = self.root / 'price.json'
        handoff.write_exclusive(price_path, {'source': 'https://docs.fly.io/about/pricing', 'oneUsdIsBillingCap': False})
        self.recipe = {'version': 'p10b-owner-preparer-recipe-v1', 'files': {'node': {'path': '/offline/node'}, 'native': {'path': '/offline/native'}, 'price': {'path': str(price_path)}},
                       'app': 'uckele-group-p10b', 'nonce': 'c' * 24, 'ownerHome': '/Users/Matt',
                       'hostSourceHead': '2' * 40, 'outputDirectory': str(self.root), 'evidenceDirectory': str(self.evidence),
                       'sealedBundlePath': str(self.root / 'sealed-session.json'),
                       'approvedBundlePath': str(self.root / 'approved-session.json')}
        self.recipe_path = self.root / 'recipe.json'
        handoff.write_exclusive(self.recipe_path, self.recipe)
        self.calls = []
        self.token_calls = 0
        self.mode = ''
        self.creation_start = None
        self.summary = None

    def ask(self, prompt):
        if 'APPROVE PRIVATE SETUP' in prompt:
            return '' if self.mode == 'scope-refusal' else 'APPROVE PRIVATE SETUP ' + fixture_digest(self.recipe)
        if 'ISSUED' in prompt:
            return '' if self.mode == 'creation-failed' else 'ISSUED'
        if 'issuance start' in prompt:
            self.creation_start = handoff.utc_now()
            return self.creation_start
        if 'issuance completion' in prompt:
            return handoff.utc_now()
        if 'Public token ID' in prompt:
            if self.mode == 'empty-id':
                return ''
            return 'offline-public-id'
        if 'Effective expiry' in prompt:
            return 'bad time' if self.mode == 'bad-expiry' else handoff.utc_after(self.creation_start, 7200)
        if 'UNREVOKED' in prompt:
            return '' if self.mode == 'metadata-refusal' else 'UNREVOKED offline-public-id'
        if 'MATCHED' in prompt:
            return 'MATCHED offline-public-id'
        if 'APPROVE SESSION' in prompt:
            return '' if self.mode == 'final-refusal' else 'APPROVE SESSION ' + self.summary['sessionDigest']
        raise AssertionError('unexpected prompt: ' + prompt)

    def token(self):
        self.token_calls += 1
        return 'offline-private-token\n' if self.mode == 'bad-token' else 'offline-private-token'

    def runner(self, args, env, timeout):
        self.calls.append((args, dict(env), timeout))
        self.assertNotIn('offline-private-token', ' '.join(args))
        self.assertNotIn('DOCKER_CONFIG', env)
        self.assertNotIn('FLY_CONFIG_DIR', env)
        if '--check-only' in args:
            return {'status': 'STATIC_READY_FOR_SEPARATELY_APPROVED_PRIVATE_SETUP', 'recipeDigest': fixture_digest(self.recipe),
                    'recipeFileSha256': hashlib.sha256(self.recipe_path.read_bytes()).hexdigest()}
        if '--validate-input' in args:
            self.assertNotIn('FLY_API_TOKEN', env)
            if self.mode in ('empty-id', 'expiry-coverage', 'scope-delayed'):
                raise handoff.Hold('invalid public evidence')
            return {'status': 'PUBLIC_INPUTS_VALIDATED', 'sessionNotStarted': True}
        if '--prepare' in args:
            if self.mode == 'preflight-failed':
                raise handoff.Hold('private remote text must not be printed')
            if self.mode == 'preflight-timeout':
                raise TimeoutError('private remote text')
            session = {'hostSourceHead': self.recipe['hostSourceHead'], 'sourceHead': 'c4944a46ac362cdcd002e077d5533b4b0843b1d0',
                       'startedAt': handoff.utc_now(), 'sessionDeadline': handoff.utc_after(handoff.utc_now(), 3600),
                       'productionReady': False, 'globalAutomationPaused': True, 'ownerPermissionDigest': 'd' * 64,
                       'budget': {'maximumUsdPerSecond': 0.000002, 'fixedIncrementalUsd': 0.8, 'priceEvidenceDigest': 'e' * 64}}
            # Actual reviewed Node canonicalization, including its float formatting.
            security = (SOURCE.parent.parent / 'server/utils/security.js').as_uri()
            code = "import{stableCanonicalJson}from '" + security + "';let b='';for await(const c of process.stdin)b+=c;process.stdout.write(stableCanonicalJson(JSON.parse(b)));"
            session_canonical = subprocess.run([shutil.which('node'), '--input-type=module', '-e', code],
                                               input=json.dumps(session), text=True, capture_output=True, check=True).stdout
            session_digest = hashlib.sha256(session_canonical.encode()).hexdigest()
            bundle = {'version': 'p10b-no-email-bundle-v1', 'status': 'AWAITING_EXACT_OWNER_APPROVAL', 'session': session,
                      'approval': {'version': 'p10b-no-email-approval-v1', 'approved': False,
                                   'sessionDigest': session_digest, 'providerCalls': 0, 'emails': 0},
                      'imageEvidence': {'registryManifestVerified': True}}
            handoff.write_exclusive(self.recipe['sealedBundlePath'], bundle)
            self.summary = {'status': 'AWAITING_EXACT_OWNER_APPROVAL', 'sessionDigest': session_digest,
                            'sessionCanonical': session_canonical,
                            'sessionDeadline': session['sessionDeadline'], 'sealedBundlePath': self.recipe['sealedBundlePath'],
                            'sealedBundleSha256': hashlib.sha256(Path(self.recipe['sealedBundlePath']).read_bytes()).hexdigest(),
                            'preflightCleanupVerified': True, 'runtimeApproved': False}
            if self.mode == 'bundle-drift':
                bundle['imageEvidence']['registryManifestVerified'] = False
                Path(self.recipe['sealedBundlePath']).write_text(json.dumps(bundle))
            return self.summary
        if '--execute' in args:
            if self.mode == 'runtime-timeout':
                raise TimeoutError('private remote text')
            if self.mode == 'runtime-failed':
                raise handoff.Hold('runtime did not close')
            handoff.write_exclusive(self.evidence / 'p10b-runtime-only-auth-closure.json',
                                    {'success': True, 'cleanupVerified': self.mode != 'cleanup-uncertain',
                                     'reapVerified': True, 'sessionDigest': self.summary['sessionDigest']})
            return {'success': True, 'productionReady': False}
        raise AssertionError('unexpected process')

    def invoke(self, tty=True):
        return handoff.run_owner(self.recipe_path, self.runner, self.ask, self.token, lambda: tty, lambda value: None,
                                 expected_recipe_sha256=hashlib.sha256(self.recipe_path.read_bytes()).hexdigest(),
                                 bootstrap=lambda _path, _sha: self.recipe)

    def test_complete_owner_entry_binds_explicit_approval_and_same_hidden_input(self):
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.token_calls, 1)
        self.assertEqual(len(self.calls), 4)
        self.assertNotIn('FLY_API_TOKEN', self.calls[0][1])
        self.assertEqual(self.calls[2][1]['FLY_API_TOKEN'], 'offline-private-token')
        self.assertEqual(self.calls[3][1]['FLY_API_TOKEN'], 'offline-private-token')
        approved = handoff.read_public(self.recipe['approvedBundlePath'])
        self.assertTrue(approved['approval']['approved'])
        self.assertEqual(approved['session']['sessionDeadline'], self.summary['sessionDeadline'])
        for file in self.root.rglob('*'):
            if file.is_file():
                self.assertNotIn(b'offline-private-token', file.read_bytes())

    def test_refusal_before_credential_input(self):
        for mode in ['scope-refusal', 'creation-failed', 'metadata-refusal', 'bad-expiry', 'empty-id', 'expiry-coverage', 'scope-delayed']:
            with self.subTest(mode=mode):
                self.setUp()
                self.mode = mode
                self.assertEqual(self.invoke(), 2)
                self.assertEqual(self.token_calls, 0)

    def test_non_tty_refuses_without_input(self):
        self.assertEqual(self.invoke(False), 2)
        self.assertEqual(self.token_calls, 0)

    def test_bootstrap_is_independent_of_recipe_interpreter_claims(self):
        self.assertTrue(callable(getattr(handoff, 'bootstrap_recipe', None)))
        malicious = self.root / 'replaced-node'
        malicious.write_bytes(b'changed interpreter')
        malicious.chmod(0o700)
        self.recipe['files']['node'] = {'path': str(malicious), 'sha256': 'a' * 64}
        self.recipe_path.write_text(json.dumps(self.recipe))
        with self.assertRaises(handoff.Hold):
            handoff.check_recipe(self.recipe_path, self.runner, hashlib.sha256(self.recipe_path.read_bytes()).hexdigest())
        self.assertEqual(self.calls, [])
        with self.assertRaises(handoff.Hold):
            handoff.check_recipe(self.recipe_path, self.runner, 'b' * 64)
        self.assertEqual(self.calls, [])

    def test_final_refusal_preserves_sealed_facts_without_runtime(self):
        self.mode = 'final-refusal'
        self.assertEqual(self.invoke(), 2)
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(Path(self.recipe['sealedBundlePath']).exists())
        self.assertFalse(Path(self.recipe['approvedBundlePath']).exists())

    def test_entry_replay_preserves_evidence_and_never_requests_a_new_token(self):
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.invoke(), 2)
        self.assertEqual(self.token_calls, 1)

    def test_failure_paths_never_claim_success_or_copy_raw_exception(self):
        for mode in ['preflight-failed', 'preflight-timeout', 'runtime-failed', 'runtime-timeout',
                     'cleanup-uncertain', 'bundle-drift', 'bad-token']:
            with self.subTest(mode=mode):
                self.setUp()
                self.mode = mode
                self.assertEqual(self.invoke(), 2)
                terminal = handoff.read_public(self.root / 'owner-terminal.json')
                self.assertFalse(terminal['success'])
                self.assertNotIn('private remote text', json.dumps(terminal))

    def test_getpass_echo_fallback_is_an_error(self):
        def fallback(_prompt):
            warnings.warn('offline fallback', handoff.getpass.GetPassWarning)
            return 'must-not-be-accepted'
        with patch.object(handoff.getpass, 'getpass', fallback):
            with self.assertRaises(handoff.getpass.GetPassWarning):
                handoff.hidden_token()

    def test_exited_leader_permission_denial_requires_positive_group_absence(self):
        child = Mock(pid=23456)
        child.wait.return_value = 0
        with patch.object(handoff.os, 'killpg', side_effect=[PermissionError(errno.EPERM, 'offline signal denied'), ProcessLookupError()]) as signal_group:
            self.assertEqual(handoff.settle_owned_group(child), 0)
        child.wait.assert_called_once_with(timeout=0)
        self.assertEqual([call.args for call in signal_group.call_args_list], [(23456, handoff.signal.SIGTERM), (23456, 0)])
        for state in ('active', 'group-present', 'probe-denied', 'other-signal-error'):
            with self.subTest(state=state):
                child = Mock(pid=23456)
                child.wait.return_value = 0
                if state == 'active':
                    child.wait.side_effect = subprocess.TimeoutExpired('owned-child', 0)
                initial = OSError() if state == 'other-signal-error' else PermissionError(errno.EPERM, 'offline signal denied')
                probe = PermissionError() if state == 'probe-denied' else None
                with patch.object(handoff.os, 'killpg', side_effect=[initial, probe]) as signal_group:
                    with self.assertRaises(handoff.Hold):
                        handoff.settle_owned_group(child)
                self.assertLessEqual(signal_group.call_count, 2)
                self.assertTrue(all(call.args[1] in (handoff.signal.SIGTERM, 0) for call in signal_group.call_args_list))

    def test_actual_fast_exited_command_can_close_without_descendants(self):
        self.assertEqual(handoff.run_command([shutil.which('node'), '-e', 'process.stdout.write("{}")'],
                                            {'PATH': '/usr/bin:/bin', 'HOME': str(self.root)}, 5), {})

    def test_actual_command_group_closes_even_after_leader_exit(self):
        for inherited_pipes, ignore_term in ((True, False), (False, False), (True, True), (False, True)):
            with self.subTest(inherited_pipes=inherited_pipes, ignore_term=ignore_term):
                pid_path = self.root / ('child-' + str(inherited_pipes) + str(ignore_term) + '.pid')
                ready_path = str(pid_path) + '.ready'
                stdio = "'inherit'" if inherited_pipes else "'ignore'"
                child_code = "const fs=require('fs');" + ("process.on('SIGTERM',()=>{});" if ignore_term else '') + "fs.writeFileSync(" + json.dumps(ready_path) + ",'ready');setInterval(()=>{},1000)"
                script = "const fs=require('fs'),{spawn}=require('child_process');const c=spawn(process.execPath,['-e'," + json.dumps(child_code) + "],{stdio:" + stdio + "});c.unref();fs.writeFileSync(" + json.dumps(str(pid_path)) + ",String(c.pid));const t=setInterval(()=>{if(fs.existsSync(" + json.dumps(ready_path) + ")){clearInterval(t);process.stdout.write('{}');}},5);"
                environment = {'PATH': '/usr/bin:/bin', 'HOME': str(self.root)}
                try:
                    try:
                        handoff.run_command([shutil.which('node'), '-e', script], environment, 0.4)
                    except handoff.Hold:
                        pass
                    child = int(pid_path.read_text())
                    end = time.monotonic() + 1
                    alive = True
                    while time.monotonic() < end:
                        try:
                            os.kill(child, 0)
                        except ProcessLookupError:
                            alive = False
                            break
                        time.sleep(0.025)
                    self.assertFalse(alive, 'owned descendant survived cleanup')
                finally:
                    if pid_path.exists():
                        try:
                            os.kill(int(pid_path.read_text()), 9)
                        except ProcessLookupError:
                            pass


if __name__ == '__main__':
    unittest.main()
