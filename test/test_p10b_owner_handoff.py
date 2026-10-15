import hashlib
import errno
import fcntl
import importlib.util
import json
import os
import pty
import select
import shlex
import shutil
import signal
import subprocess
import time
from pathlib import Path
import tempfile
import termios
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
        self.recipe = {'version': 'p10b-owner-preparer-recipe-v1', 'files': {'node': {'path': '/offline/node'}, 'fly': {'path': '/offline/pinned-flyctl'}, 'native': {'path': '/offline/native'}, 'price': {'path': str(price_path)}},
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
        self.metadata_path = self.root / 'public-token-metadata.json'
        self.metadata = {'version': 'p10b-owner-token-metadata-v1', 'app': self.recipe['app'], 'tokens': [
            {'tokenId': 'older-public-id', 'tokenName': 'p10b-runtime-no-email-' + 'a' * 24,
             'expiresAt': handoff.utc_after(handoff.utc_now(), 7200), 'revokedAt': handoff.utc_now()},
            {'tokenId': 'offline-public-id', 'tokenName': 'p10b-runtime-no-email-' + self.recipe['nonce'],
             'expiresAt': handoff.utc_after(handoff.utc_now(), 7200), 'revokedAt': None}]}
        handoff.write_exclusive(self.metadata_path, self.metadata)

    def test_local_metadata_import_selects_exact_row_without_id_or_expiry_entry(self):
        prompts, messages = [], []
        def ask(prompt):
            prompts.append(prompt)
            if 'UNREVOKED' in prompt:
                return 'UNREVOKED'
            if 'MATCHED' in prompt:
                return 'MATCHED'
            return self.ask(prompt)
        self.assertEqual(self.invoke_with_public_input(ask, messages), 0)
        self.assertFalse(any('Public token ID' in p or 'Effective expiry' in p for p in prompts))
        receipt = handoff.read_public(self.root / 'issuance-receipt.json')
        selected = self.metadata['tokens'][1]
        self.assertEqual(receipt['tokenId'], selected['tokenId'])
        self.assertEqual(receipt['expiresAt'], selected['expiresAt'])
        self.assertEqual(receipt['tokenName'], selected['tokenName'])
        self.assertIn('owner-attested', '\n'.join(messages))
        self.assertNotIn('older-public-id', '\n'.join(messages))
        self.assertEqual(self.token_calls, 1)
        self.assertNotIn('FLY_API_TOKEN', self.calls[1][1])

    def test_metadata_import_holds_on_directory_or_read_identity_uncertainty(self):
        self.root.chmod(0o755)
        with self.assertRaises(handoff.PublicInputHold):
            handoff.import_public_token_metadata(self.recipe)
        self.root.chmod(0o700)
        real_fstat = os.fstat
        calls = 0
        def changed(descriptor):
            nonlocal calls
            calls += 1
            if calls == 3:
                with self.metadata_path.open('ab') as stream:
                    stream.write(b' ')
            return real_fstat(descriptor)
        with patch.object(handoff.os, 'fstat', side_effect=changed):
            with self.assertRaises(handoff.PublicInputHold):
                handoff.import_public_token_metadata(self.recipe)

    def test_public_import_requires_literal_match_attestation_before_credentials(self):
        issued_at = handoff.utc_now()
        snapshots = []
        def ask(prompt):
            if 'issuance start' in prompt or 'issuance completion' in prompt:
                return issued_at
            if 'MATCHED' in prompt:
                snapshots.append(self.metadata_path.read_bytes())
                return 'MATCHED offline-public-id'  # The new prompt requires the literal word.
            return self.ask(prompt)
        original = self.metadata_path.read_bytes()
        self.assertEqual(self.invoke_with_public_input(ask, []), 2)
        self.assertEqual(snapshots, [original])
        self.assertEqual(self.token_calls, 0)
        self.assertFalse((self.root / 'issuance-receipt.json').exists())

    def test_invalid_metadata_import_holds_before_credentials_without_raw_output(self):
        for mode in ('missing', 'symlink', 'fifo', 'permissions', 'oversized', 'malformed', 'duplicate-key',
                     'extra-field', 'wrong-app', 'no-match', 'duplicate-match', 'duplicate-id',
                     'revoked', 'bad-expiry', 'noncanonical-expiry', 'nan', 'credential-id', 'credential-name'):
            with self.subTest(mode=mode):
                self.setUp()
                self.metadata_path.unlink()
                selected = self.metadata['tokens'][1]
                secret = 'FlyV1_SYNTHETIC_PRIVATE_INPUT'
                raw = None
                if mode == 'symlink':
                    target = self.root / 'metadata-target.json'
                    handoff.write_exclusive(target, self.metadata)
                    self.metadata_path.symlink_to(target)
                elif mode == 'fifo': os.mkfifo(self.metadata_path, 0o600)
                elif mode == 'oversized': raw = b' ' * 65537
                elif mode == 'malformed': raw = secret.encode()
                elif mode == 'duplicate-key':
                    raw = json.dumps(self.metadata).replace('"version":', '"version": "' + secret + '", "version":', 1).encode()
                elif mode == 'extra-field': selected['credential'] = secret
                elif mode == 'wrong-app': self.metadata['app'] = 'different-app'
                elif mode == 'no-match': self.metadata['tokens'].pop()
                elif mode == 'duplicate-match': self.metadata['tokens'].append(dict(selected, tokenId='other-id'))
                elif mode == 'duplicate-id': self.metadata['tokens'][0]['tokenId'] = selected['tokenId']
                elif mode == 'revoked': selected['revokedAt'] = handoff.utc_now()
                elif mode == 'bad-expiry': selected['expiresAt'] = secret
                elif mode == 'noncanonical-expiry': selected['expiresAt'] = selected['expiresAt'].replace('Z', '+00:00')
                elif mode == 'nan': selected['revokedAt'] = float('nan')
                elif mode == 'credential-id': selected['tokenId'] = secret
                elif mode == 'credential-name': selected['tokenName'] = secret
                if mode not in ('missing', 'symlink', 'fifo'):
                    if raw is None: handoff.write_exclusive(self.metadata_path, self.metadata)
                    else:
                        self.metadata_path.write_bytes(raw)
                        self.metadata_path.chmod(0o600)
                    if mode == 'permissions': self.metadata_path.chmod(0o644)
                messages = []
                self.assertEqual(self.invoke_with_public_input(self.ask, messages), 2)
                self.assertEqual(self.token_calls, 0)
                self.assertTrue(all('--check-only' in args for args, _, _ in self.calls))
                terminal = handoff.read_public(self.root / 'owner-terminal.json')
                self.assertEqual(terminal['publicInputField'], 'public-token-metadata')
                self.assertEqual(terminal['publicInputError'], 'INVALID_PUBLIC_METADATA')
                self.assertNotIn(secret, '\n'.join(messages) + json.dumps(terminal))
                self.assertFalse((self.root / 'issuance-receipt.json').exists())

    def ask(self, prompt):
        if 'APPROVE PRIVATE SETUP' in prompt:
            return '' if self.mode == 'scope-refusal' else 'APPROVE PRIVATE SETUP ' + fixture_digest(self.recipe)
        if 'ISSUED' in prompt:
            return '' if self.mode == 'creation-failed' else 'ISSUED'
        if 'issuance start' in prompt:
            self.creation_start = handoff.utc_now()
            return self.creation_start
        if 'issuance completion' in prompt:
            if self.mode in ('empty-id', 'bad-expiry'):
                self.metadata['tokens'][1]['tokenId' if self.mode == 'empty-id' else 'expiresAt'] = ''
                self.metadata_path.write_text(json.dumps(self.metadata))
            return handoff.utc_now()
        if 'UNREVOKED' in prompt:
            return '' if self.mode == 'metadata-refusal' else 'UNREVOKED'
        if 'MATCHED' in prompt:
            return '' if self.mode == 'match-refusal' else 'MATCHED'
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

    def test_owner_creation_command_ignores_wrong_path_architecture_and_forced_update(self):
        wrong_directory = self.root / 'wrong-path'
        pinned_directory = self.root / "verified arm64 cli's directory"
        wrong_directory.mkdir()
        pinned_directory.mkdir()
        def stub(file, version, architecture):
            file.write_text('#!' + handoff.sys.executable + '\n'
                            'import json,os,sys\n'
                            'print(json.dumps({"version":' + repr(version) + ',"architecture":' + repr(architecture) + ',\n'
                            '"argv":sys.argv[1:],"forceUpdatePresent":"FLY_UPDATE_CHECK" in os.environ,\n'
                            '"noUpdate":os.environ.get("FLY_NO_UPDATE_CHECK")}))\n')
            file.chmod(0o700)
        stub(wrong_directory / 'fly', '0.4.87', 'darwin/amd64')
        pinned = pinned_directory / 'flyctl'
        stub(pinned, '0.4.115', 'darwin/arm64')
        self.recipe['files']['fly'] = {'path': str(pinned), 'sha256': hashlib.sha256(pinned.read_bytes()).hexdigest()}
        self.recipe_path.write_text(json.dumps(self.recipe))
        self.mode = 'creation-failed'
        emitted = []
        self.assertEqual(handoff.run_owner(self.recipe_path, self.runner, self.ask, self.token, lambda: True,
                         emitted.append, expected_recipe_sha256=hashlib.sha256(self.recipe_path.read_bytes()).hexdigest(),
                         bootstrap=lambda _path, _sha: self.recipe), 2)
        commands = [line for line in emitted if ' tokens create deploy ' in line]
        self.assertEqual(len(commands), 1)
        environment = {'PATH': str(wrong_directory) + ':/usr/bin:/bin', 'HOME': str(self.root),
                       'FLY_UPDATE_CHECK': '1', 'FLY_NO_UPDATE_CHECK': '0'}
        wrong = subprocess.run(['fly', 'version'], env=environment, capture_output=True, text=True, check=True, timeout=5)
        self.assertEqual(json.loads(wrong.stdout)['architecture'], 'darwin/amd64')
        result = subprocess.run(['/bin/sh', '-c', commands[0]], env=environment,
                                capture_output=True, text=True, check=True, timeout=5)
        selected = json.loads(result.stdout)
        self.assertEqual(selected['version'], '0.4.115')
        self.assertEqual(selected['architecture'], 'darwin/arm64')
        self.assertFalse(selected['forceUpdatePresent'])
        self.assertEqual(selected['noUpdate'], '1')
        self.assertEqual(selected['argv'], ['tokens', 'create', 'deploy', '--app', 'uckele-group-p10b',
                         '--expiry', '2h', '--name', 'p10b-runtime-no-email-' + self.recipe['nonce']])
        metadata_commands = [line for line in emitted if ' tokens list ' in line]
        self.assertEqual(len(metadata_commands), 1)
        metadata = subprocess.run(['/bin/sh', '-c', metadata_commands[0]], env=environment,
                                  capture_output=True, text=True, check=True, timeout=5)
        metadata = json.loads(metadata.stdout)
        self.assertEqual(metadata['version'], '0.4.115')
        self.assertEqual(metadata['architecture'], 'darwin/arm64')
        self.assertFalse(metadata['forceUpdatePresent'])
        self.assertEqual(metadata['noUpdate'], '1')
        self.assertEqual(metadata['argv'], ['tokens', 'list', '--app', 'uckele-group-p10b', '--scope', 'app'])
        self.assertFalse(any(line.startswith('fly ') for line in emitted))
        self.assertEqual(shlex.split(commands[0])[0], '/usr/bin/env')
        self.assertEqual(self.token_calls, 0)
        self.assertFalse(Path(self.recipe['approvedBundlePath']).exists())

    def test_failed_creation_consumes_attempt_without_issuance_or_replay(self):
        self.mode = 'creation-failed'
        prompts = []
        def ask(prompt):
            prompts.append(prompt)
            return self.ask(prompt)
        def invoke():
            return handoff.run_owner(self.recipe_path, self.runner, ask, self.token, lambda: True,
                     lambda _value: None, expected_recipe_sha256=hashlib.sha256(self.recipe_path.read_bytes()).hexdigest(),
                     bootstrap=lambda _path, _sha: self.recipe)
        self.assertEqual(invoke(), 2)
        permission = (self.root / 'private-setup-scope.json').read_bytes()
        terminal = (self.root / 'owner-terminal.json').read_bytes()
        self.assertEqual(json.loads(terminal)['phase'], 'public-issuance')
        self.assertFalse(json.loads(terminal)['credentialInputRequested'])
        self.assertFalse(json.loads(terminal)['authenticatedPreflightRequested'])
        self.assertFalse((self.root / 'issuance-receipt.json').exists())
        count = len(prompts)
        self.assertEqual(invoke(), 2)
        self.assertEqual(len(prompts), count)
        self.assertEqual((self.root / 'private-setup-scope.json').read_bytes(), permission)
        self.assertEqual((self.root / 'owner-terminal.json').read_bytes(), terminal)
        self.assertEqual(self.token_calls, 0)
        self.assertTrue(all('--check-only' in args for args, _, _ in self.calls))

    def test_issuance_confirmation_explicitly_requests_literal_word_not_token(self):
        prompts = []
        def ask(prompt):
            prompts.append(prompt)
            return self.ask(prompt)
        self.assertEqual(self.invoke_with_public_input(ask, []), 0)
        issued = [prompt for prompt in prompts if 'ISSUED' in prompt]
        self.assertEqual(len(issued), 1)
        self.assertIn('literal ISSUED', issued[0])
        self.assertIn('NOT THE TOKEN', issued[0])

    def test_wrong_issuance_confirmation_or_interruption_consumes_attempt_before_credentials(self):
        secret = 'fm2_SYNTHETIC_PRIVATE_INPUT'
        for response in (secret, EOFError, KeyboardInterrupt):
            with self.subTest(response=response):
                self.setUp()
                prompts, messages = [], []
                def ask(prompt):
                    prompts.append(prompt)
                    if 'ISSUED' in prompt:
                        if isinstance(response, type):
                            raise response()
                        return response
                    return self.ask(prompt)
                self.assertEqual(self.invoke_with_public_input(ask, messages), 2)
                terminal = (self.root / 'owner-terminal.json').read_bytes()
                permission = (self.root / 'private-setup-scope.json').read_bytes()
                self.assertEqual(json.loads(terminal)['phase'], 'public-issuance')
                self.assertFalse(json.loads(terminal)['credentialInputRequested'])
                self.assertFalse(json.loads(terminal)['authenticatedPreflightRequested'])
                self.assertEqual(self.token_calls, 0)
                self.assertTrue(all('--check-only' in args for args, _, _ in self.calls))
                for name in ('issuance-receipt.json', 'sealed-session.json', 'approved-session.json', 'owner-final-approval.json'):
                    self.assertFalse((self.root / name).exists())
                count = len(prompts)
                self.assertEqual(self.invoke_with_public_input(ask, messages), 2)
                self.assertEqual(len(prompts), count)
                self.assertEqual((self.root / 'owner-terminal.json').read_bytes(), terminal)
                self.assertEqual((self.root / 'private-setup-scope.json').read_bytes(), permission)
                self.assertNotIn(secret, '\n'.join(prompts + messages))
                for file in self.root.rglob('*'):
                    if file.is_file():
                        self.assertNotIn(secret.encode(), file.read_bytes())

    def test_one_issuance_confirmation_correction_preserves_permission_and_issuance_times(self):
        secret = 'fm2_SYNTHETIC_MISTAKEN_CONFIRMATION'
        responses = [secret, 'ISSUED']
        prompts, messages, permissions = [], [], []
        self.creation_start = handoff.utc_now()
        issued_at = self.creation_start
        def ask(prompt):
            prompts.append(prompt)
            if 'ISSUED' in prompt:
                permissions.append((self.root / 'private-setup-scope.json').read_bytes())
                return responses.pop(0)
            if 'issuance start' in prompt or 'issuance completion' in prompt:
                return issued_at
            return self.ask(prompt)
        self.assertEqual(self.invoke_with_public_input(ask, messages), 0)
        self.assertEqual(responses, [])
        self.assertEqual(len(permissions), 2)
        self.assertEqual(permissions[0], permissions[1])
        self.assertEqual(permissions[0], (self.root / 'private-setup-scope.json').read_bytes())
        receipt = handoff.read_public(self.root / 'issuance-receipt.json')
        self.assertEqual(receipt['issuanceStartedAt'], issued_at)
        self.assertEqual(receipt['issuanceCompletedAt'], issued_at)
        self.assertEqual(receipt['tokenName'], 'p10b-runtime-no-email-' + self.recipe['nonce'])
        self.assertEqual(self.token_calls, 1)
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(self.calls[2][1]['FLY_API_TOKEN'], 'offline-private-token')
        self.assertEqual(self.calls[3][1]['FLY_API_TOKEN'], 'offline-private-token')
        notice = '\n'.join(messages)
        self.assertIn('Entry discarded', notice)
        self.assertIn('WORD ISSUED', notice)
        self.assertIn('later hidden credential prompt', notice)
        self.assertNotIn(secret, '\n'.join(prompts + messages))
        for file in self.root.rglob('*'):
            if file.is_file():
                self.assertNotIn(secret.encode(), file.read_bytes())

    def test_confirmation_correction_does_not_bypass_public_admission_or_authorize_runtime(self):
        for mode in ('scope-delayed', 'final-refusal'):
            with self.subTest(mode=mode):
                self.setUp()
                self.mode = mode
                responses = ['fm2_SYNTHETIC_MISTAKEN_CONFIRMATION', 'ISSUED']
                def ask(prompt):
                    return responses.pop(0) if 'ISSUED' in prompt else self.ask(prompt)
                self.assertEqual(self.invoke_with_public_input(ask, []), 2)
                self.assertEqual(responses, [])
                self.assertFalse(any('--execute' in args for args, _, _ in self.calls))
                self.assertFalse((self.root / 'approved-session.json').exists())
                if mode == 'scope-delayed':
                    self.assertEqual(self.token_calls, 0)
                    self.assertFalse(any('--prepare' in args for args, _, _ in self.calls))
                else:
                    self.assertEqual(self.token_calls, 1)
                    self.assertTrue((self.root / 'sealed-session.json').exists())

    def test_failed_issuance_attestation_closes_without_offering_correction(self):
        prompts = []
        def ask(prompt):
            prompts.append(prompt)
            return 'FAILED' if 'ISSUED' in prompt else self.ask(prompt)
        self.assertEqual(self.invoke_with_public_input(ask, []), 2)
        self.assertEqual(sum('ISSUED' in prompt for prompt in prompts), 1)
        self.assertEqual(self.token_calls, 0)
        self.assertTrue(all('--check-only' in args for args, _, _ in self.calls))

    def test_confirmation_interruption_on_correction_never_requests_credentials(self):
        for error in (EOFError, KeyboardInterrupt, OSError):
            with self.subTest(error=error):
                self.setUp()
                count = 0
                messages = []
                def ask(prompt):
                    nonlocal count
                    if 'ISSUED' in prompt:
                        count += 1
                        if count == 1:
                            return 'fm2_SYNTHETIC_MISTAKEN_CONFIRMATION'
                        raise error('SYNTHETIC_PRIVATE_ERROR')
                    return self.ask(prompt)
                self.assertEqual(self.invoke_with_public_input(ask, messages), 2)
                self.assertEqual(count, 2)
                self.assertEqual(self.token_calls, 0)
                self.assertFalse((self.root / 'issuance-receipt.json').exists())
                self.assertTrue(all('--check-only' in args for args, _, _ in self.calls))
                self.assertNotIn('SYNTHETIC_PRIVATE_ERROR', '\n'.join(messages))

    def test_owned_synthetic_tty_confirmation_correction_flushes_paste_and_holds_on_uncertainty(self):
        code = """import importlib.util,json,os,select,sys,termios
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('fixtures',sys.argv[1]);f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
t=f.OwnerEntryTests();t.setUp();m=f.handoff;mode=sys.argv[2]
real_input=m.masked_owner_input;real_flush=m.termios.tcflush;count=0;flushes=0;permission=None
def ask(prompt):
 global count,permission
 if 'ISSUED' in prompt:
  count+=1
  current=(t.root/'private-setup-scope.json').read_bytes()
  if permission is None:permission=current
  assert current==permission
  return real_input(prompt)
 return t.ask(prompt)
def flush(fd,queue):
 global flushes
 flushes+=1
 if mode=='flush-failure' and flushes==2:raise termios.error('SYNTHETIC_PRIVATE_FLUSH_ERROR')
 return real_flush(fd,queue)
def token():
 print('HIDDEN_INPUT_REQUESTED',flush=True)
 return t.token()
with patch.object(m,'masked_owner_input',ask),patch.object(m.termios,'tcflush',flush):
 result=m.run_owner(t.recipe_path,runner=t.runner,token_input=token,private_tty=lambda:True,emit=lambda s:print(s,flush=True),expected_recipe_sha256=f.hashlib.sha256(t.recipe_path.read_bytes()).hexdigest(),bootstrap=lambda *_:t.recipe)
terminal=json.loads((t.root/'owner-terminal.json').read_text())
files=[p.read_bytes() for p in t.root.rglob('*') if p.is_file()]
assert not any(b'fm2_SYNTHETIC_PASTE' in b or b'SYNTHETIC_RESIDUAL' in b for b in files)
assert termios.tcgetattr(0)[3]&termios.ECHO
assert not select.select([sys.stdin],[],[],0.1)[0]
assert (t.root/'private-setup-scope.json').read_bytes()==permission
print('RESULT '+json.dumps({'exit':result,'prompts':count,'credentialCalls':t.token_calls,'authenticated':terminal['authenticatedPreflightRequested'],'phase':terminal['phase'],'receipt':(t.root/'issuance-receipt.json').exists()}),flush=True)
t.doCleanups()
"""
        prompt = b'Type literal ISSUED, NOT THE TOKEN, only after that exact creation succeeds: '
        for mode in ('recover', 'second-invalid', 'interrupt', 'eof', 'flush-failure'):
            with self.subTest(mode=mode):
                master, slave = pty.openpty()
                def controlling_tty():
                    os.setsid()
                    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
                child = subprocess.Popen([handoff.sys.executable, '-B', '-c', code, str(Path(__file__).resolve()), mode],
                                         stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_tty,
                                         env={'PATH': str(Path(shutil.which('node')).parent) + ':/usr/bin:/bin', 'HOME': str(self.root)})
                os.close(slave)
                output = bytearray()
                def until(marker, occurrences=1):
                    end = time.monotonic() + 5
                    while output.count(marker) < occurrences and time.monotonic() < end:
                        if select.select([master], [], [], 0.1)[0]:
                            try:
                                data = os.read(master, 65536)
                            except OSError:
                                break
                            if not data:
                                break
                            output.extend(data)
                    self.assertGreaterEqual(output.count(marker), occurrences, output.decode(errors='replace'))
                try:
                    until(prompt)
                    os.write(master, b'fm2_SYNTHETIC_PASTE\nISSUED\nSYNTHETIC_RESIDUAL\n')
                    if mode != 'flush-failure':
                        until(prompt, 2)
                        self.assertIsNone(child.poll(), 'queued paste advanced the correction')
                        self.assertNotIn(b'HIDDEN_INPUT_REQUESTED', output)
                        if mode == 'recover':
                            os.write(master, b'ISSUED\nSYNTHETIC_RESIDUAL\n')
                        elif mode == 'second-invalid':
                            os.write(master, b'fm2_SYNTHETIC_PASTE\nSYNTHETIC_RESIDUAL\n')
                        elif mode == 'eof':
                            os.write(master, b'\x04')
                        else:
                            child.send_signal(signal.SIGINT)
                    until(b'RESULT ')
                    self.assertEqual(child.wait(timeout=5), 0)
                    line = output.split(b'RESULT ', 1)[1].splitlines()[0]
                    result = json.loads(line)
                    recovered = mode == 'recover'
                    self.assertEqual(result['exit'], 0 if recovered else 2)
                    self.assertEqual(result['prompts'], 1 if mode == 'flush-failure' else 2)
                    self.assertEqual(result['credentialCalls'], 1 if recovered else 0)
                    self.assertEqual(result['authenticated'], recovered)
                    self.assertEqual(result['receipt'], recovered)
                    self.assertNotIn(b'fm2_SYNTHETIC_PASTE', output)
                    self.assertNotIn(b'SYNTHETIC_RESIDUAL', output)
                    self.assertNotIn(b'SYNTHETIC_PRIVATE_FLUSH_ERROR', output)
                finally:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=5)
                    os.close(master)

    def test_refusal_before_credential_input(self):
        for mode in ['scope-refusal', 'creation-failed', 'metadata-refusal', 'match-refusal', 'bad-expiry', 'empty-id', 'expiry-coverage', 'scope-delayed']:
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

    def invoke_with_public_input(self, ask, messages):
        return handoff.run_owner(self.recipe_path, self.runner, ask, self.token,
                                 lambda: True, messages.append,
                                 expected_recipe_sha256=hashlib.sha256(self.recipe_path.read_bytes()).hexdigest(),
                                 bootstrap=lambda _path, _sha: self.recipe)

    def test_one_public_timestamp_correction_keeps_authentication_after_metadata(self):
        remaining = ['fm2_SYNTHETIC_PRIVATE_INPUT', None]
        def ask(prompt):
            if 'issuance completion' in prompt and remaining:
                value = remaining.pop(0)
                if value is not None:
                    return value
            return self.ask(prompt)
        messages = []
        self.assertEqual(self.invoke_with_public_input(ask, messages), 0)
        self.assertEqual(self.token_calls, 1)
        self.assertNotIn('fm2_SYNTHETIC_PRIVATE_INPUT', '\n'.join(messages))

    def test_rejected_public_input_has_safe_field_diagnostic_before_credentials(self):
        secret = 'fm2_SYNTHETIC_PRIVATE_INPUT'
        messages = []
        def ask(prompt):
            return secret if 'issuance completion' in prompt else self.ask(prompt)
        self.assertEqual(self.invoke_with_public_input(ask, messages), 2)
        terminal = handoff.read_public(self.root / 'owner-terminal.json')
        self.assertEqual(terminal.get('publicInputField'), 'issuance-completion-utc')
        self.assertEqual(terminal.get('publicInputError'), 'INVALID_UTC')
        self.assertFalse(terminal.get('credentialInputRequested', True))
        self.assertFalse(terminal.get('authenticatedPreflightRequested', True))
        self.assertEqual(self.token_calls, 0)
        self.assertFalse((self.root / 'issuance-receipt.json').exists())
        self.assertNotIn(secret, '\n'.join(messages))
        for file in self.root.rglob('*'):
            if file.is_file():
                self.assertNotIn(secret.encode(), file.read_bytes())

    def test_eof_and_cancellation_identify_public_field_without_private_input(self):
        for error, code in [(EOFError, 'INPUT_ENDED'), (KeyboardInterrupt, 'INPUT_CANCELLED')]:
            with self.subTest(code=code):
                self.setUp()
                def ask(prompt):
                    if 'issuance completion' in prompt:
                        raise error()
                    return self.ask(prompt)
                self.assertEqual(self.invoke_with_public_input(ask, []), 2)
                terminal = handoff.read_public(self.root / 'owner-terminal.json')
                self.assertEqual(terminal.get('publicInputField'), 'issuance-completion-utc')
                self.assertEqual(terminal.get('publicInputError'), code)
                self.assertEqual(self.token_calls, 0)

    def test_credential_like_imported_id_is_rejected_before_echo_or_receipt(self):
        secret = 'fm2_SYNTHETIC_PRIVATE_INPUT'
        self.metadata['tokens'][1]['tokenId'] = secret
        self.metadata_path.write_text(json.dumps(self.metadata))
        prompts = []
        def ask(prompt):
            prompts.append(prompt)
            return self.ask(prompt)
        self.assertEqual(self.invoke_with_public_input(ask, []), 2)
        self.assertNotIn(secret, '\n'.join(prompts))
        self.assertFalse((self.root / 'issuance-receipt.json').exists())
        self.assertEqual(self.token_calls, 0)

    def test_console_closes_before_terminal_success_and_closure_failure_holds(self):
        for closure_failed in (False, True):
            with self.subTest(closure_failed=closure_failed):
                self.setUp()
                console = Mock()
                messages = []
                def close(*_args):
                    self.assertFalse((self.root / 'owner-terminal.json').exists())
                    self.assertFalse(any('runtime and private cleanup verified' in message for message in messages))
                    if closure_failed:
                        raise OSError('SYNTHETIC_PRIVATE_CLOSURE_ERROR')
                console.__enter__ = Mock()
                console.__exit__ = Mock(side_effect=close)
                with patch.object(handoff, 'private_owner_console', return_value=console), patch.object(handoff, 'masked_owner_input', self.ask):
                    result = handoff.run_owner(self.recipe_path, self.runner, token_input=self.token,
                                               private_tty=lambda: True, emit=messages.append,
                                               expected_recipe_sha256=hashlib.sha256(self.recipe_path.read_bytes()).hexdigest(),
                                               bootstrap=lambda _path, _sha: self.recipe)
                self.assertEqual(result, 2 if closure_failed else 0)
                terminal = handoff.read_public(self.root / 'owner-terminal.json')
                self.assertEqual(terminal['success'], not closure_failed)
                self.assertNotIn('SYNTHETIC_PRIVATE_CLOSURE_ERROR', '\n'.join(messages) + json.dumps(terminal))

    def test_console_flush_precedes_echo_restore_and_flush_failure_leaves_echo_off(self):
        for flush_failed in (False, True):
            with self.subTest(flush_failed=flush_failed):
                events = []
                original = [0, 0, 0, termios.ECHO, 0, 0, []]
                def flush(descriptor, mode):
                    events.append(('flush', descriptor, mode))
                    if flush_failed:
                        raise OSError('SYNTHETIC_PRIVATE_FLUSH_ERROR')
                def set_attrs(descriptor, mode, attrs):
                    events.append(('attrs', descriptor, mode, attrs[3]))
                with patch.object(handoff.os, 'open', return_value=123) as opened, patch.object(handoff.os, 'isatty', return_value=True), patch.object(handoff.os, 'close') as closed, patch.object(handoff.termios, 'tcgetattr', return_value=original), patch.object(handoff.termios, 'tcflush', side_effect=flush), patch.object(handoff.termios, 'tcsetattr', side_effect=set_attrs):
                    def use():
                        with handoff.private_owner_console():
                            raise KeyboardInterrupt()
                    with self.assertRaises(OSError if flush_failed else KeyboardInterrupt):
                        use()
                self.assertEqual(opened.call_args.args[0], '/dev/tty')
                closed.assert_called_once_with(123)
                self.assertEqual(events[0], ('attrs', 123, termios.TCSAFLUSH, 0))
                self.assertEqual(events[1], ('flush', 123, termios.TCIFLUSH))
                self.assertEqual(len(events), 2 if flush_failed else 3)
                if not flush_failed:
                    self.assertEqual(events[2], ('attrs', 123, termios.TCSAFLUSH, termios.ECHO))

    def test_repeated_termination_cannot_skip_input_flush_during_signal_cleanup(self):
        handlers = {number: signal.SIG_DFL for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT, signal.SIGINT)}
        blocked = set()
        def mask(how, numbers):
            previous = set(blocked)
            if how == signal.SIG_BLOCK:
                blocked.update(numbers)
            else:
                blocked.clear()
                blocked.update(numbers)
            return previous
        def install(number, handler):
            # Reproduce delivery between sequential SIG_IGN assignments. With
            # an atomic mask, repeated delivery cannot interrupt the flush.
            if number == signal.SIGHUP and handler == signal.SIG_IGN and number not in blocked:
                handlers[number](number, None)
            handlers[number] = handler
        original = [0, 0, 0, termios.ECHO, 0, 0, []]
        with patch.object(handoff.os, 'open', return_value=123), patch.object(handoff.os, 'isatty', return_value=True), patch.object(handoff.os, 'close'), patch.object(handoff.termios, 'tcgetattr', return_value=original), patch.object(handoff.termios, 'tcflush') as flushed, patch.object(handoff.termios, 'tcsetattr'), patch.object(handoff.signal, 'getsignal', side_effect=lambda number: handlers[number]), patch.object(handoff.signal, 'signal', side_effect=install), patch.object(handoff.signal, 'pthread_sigmask', side_effect=mask):
            try:
                with handoff.private_owner_console():
                    pass
            except handoff.Hold:
                pass
        flushed.assert_called_once_with(123, termios.TCIFLUSH)
        self.assertEqual(blocked, set(), 'original signal mask must be restored after cleanup')

    def test_owned_synthetic_tty_masks_batch_paste_and_discards_residual_input(self):
        self.assertTrue(callable(getattr(handoff, 'private_owner_console', None)))
        self.assertTrue(callable(getattr(handoff, 'masked_owner_input', None)))
        code = """import importlib.util,os,select,sys
spec=importlib.util.spec_from_file_location('owner',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with m.private_owner_console():
 first=m.masked_owner_input('FIRST: ')
 second=m.masked_owner_input('SECOND: ')
 assert first=='2026-10-14T15:14:04Z' and second=='2026-10-14T15:14:09Z'
 assert m.masked_owner_input('FINAL: ')=='DONE'
assert not select.select([sys.stdin],[],[],0.1)[0], 'queued paste reached shell boundary'
print('SAFE_END',flush=True)
"""
        master, slave = pty.openpty()
        def controlling_tty():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        child = subprocess.Popen([handoff.sys.executable, '-B', '-c', code, str(SOURCE)],
                                 stdin=slave, stdout=slave, stderr=slave,
                                 preexec_fn=controlling_tty, env={'PATH': '/usr/bin:/bin', 'HOME': str(self.root)})
        os.close(slave)
        output = bytearray()
        def until(marker):
            end = time.monotonic() + 5
            while marker not in output and time.monotonic() < end:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    output.extend(data)
            self.assertIn(marker, output)
        try:
            until(b'FIRST: ')
            os.write(master, b'2026-10-14T15:14:04Z\nfm2_SYNTHETIC_PRIVATE_INPUT\n2026-10-14T15:14:09Z\n')
            until(b'SECOND: ')
            self.assertIsNone(child.poll(), 'queued public/token lines advanced the second prompt')
            os.write(master, b'2026-10-14T15:14:09Z\n')
            until(b'FINAL: ')
            os.write(master, b'DONE\nSYNTHETIC_RESIDUAL_COMMAND\n')
            until(b'SAFE_END')
            self.assertEqual(child.wait(timeout=5), 0)
            self.assertNotIn(b'fm2_SYNTHETIC_PRIVATE_INPUT', output)
            self.assertNotIn(b'SYNTHETIC_RESIDUAL_COMMAND', output)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            os.close(master)

    def test_owned_synthetic_tty_termination_flushes_before_return_to_shell(self):
        code = """import importlib.util,os,select,signal,sys,termios
spec=importlib.util.spec_from_file_location('owner',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
previous=signal.getsignal(signal.SIGTERM)
try:
 with m.private_owner_console():
  print('MASKED_READY',flush=True)
  signal.pause()
except m.Hold:
 pass
assert signal.getsignal(signal.SIGTERM)==previous
assert termios.tcgetattr(0)[3]&termios.ECHO
assert not select.select([sys.stdin],[],[],0.1)[0], 'queued paste reached shell boundary'
print('SAFE_SIGNAL_END',flush=True)
"""
        master, slave = pty.openpty()
        def controlling_tty():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        child = subprocess.Popen([handoff.sys.executable, '-B', '-c', code, str(SOURCE)],
                                 stdin=slave, stdout=slave, stderr=slave,
                                 preexec_fn=controlling_tty, env={'PATH': '/usr/bin:/bin', 'HOME': str(self.root)})
        os.close(slave)
        output = bytearray()
        def until(marker):
            end = time.monotonic() + 5
            while marker not in output and time.monotonic() < end:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    output.extend(data)
            self.assertIn(marker, output)
        try:
            until(b'MASKED_READY')
            os.write(master, b'fm2_SYNTHETIC_PRIVATE_INPUT\nSYNTHETIC_RESIDUAL_COMMAND\n')
            child.send_signal(signal.SIGTERM)
            until(b'SAFE_SIGNAL_END')
            self.assertEqual(child.wait(timeout=5), 0)
            self.assertNotIn(b'fm2_SYNTHETIC_PRIVATE_INPUT', output)
            self.assertNotIn(b'SYNTHETIC_RESIDUAL_COMMAND', output)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            os.close(master)

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
