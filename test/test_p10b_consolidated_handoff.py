"""Offline public-receipt and TTY integration. Never runs production issuance."""
import hashlib
import json
import os
from pathlib import Path
import unittest
import test_p10b_owner_handoff as legacy

handoff = legacy.handoff

class ConsolidatedTests(unittest.TestCase):
    def setUp(self):
        self.f = legacy.OwnerEntryTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.directory = self.f.root / 'owner-public-issuance'
        self.f.recipe['ownerIssuanceDirectory'] = str(self.directory)
        self.f.recipe_path.write_text(handoff.canonical(self.f.recipe) + '\n')
        self.messages = []
        self.prompts = []

    def stage(self):
        f = self.f
        self.directory.mkdir(mode=0o700)
        now = handoff.utc_now()
        result = {'startedAt': now, 'completedAt': now, 'exitCode': 0, 'normalReturn': True,
                  'elapsedMonotonicMs': 0, 'ownedGroupClosed': True, 'closedWithoutSignals': True, 'success': True}
        self.records = {
            'intent.json': {'version': 'p10b-owner-issuance-intent-v1', 'attemptedAt': now,
                'app': f.recipe['app'], 'tokenName': 'p10b-runtime-no-email-' + f.recipe['nonce'],
                'recipeDigest': legacy.fixture_digest(f.recipe),
                'setupPermissionSha256': hashlib.sha256((f.root / 'private-setup-scope.json').read_bytes()).hexdigest(),
                'noRetry': True, 'productionReady': False, 'globalAutomationPaused': True},
            'creator-result.json': dict(result), 'list-result.json': dict(result),
            'public-staging-ready.json': {'version': 'p10b-owner-public-staging-v1', 'app': f.recipe['app'],
                'tokenName': 'p10b-runtime-no-email-' + f.recipe['nonce'], 'recipeDigest': legacy.fixture_digest(f.recipe),
                'issuanceStartedAt': now, 'issuanceCompletedAt': now, 'creationSucceeded': True,
                'listSucceeded': True, 'ownedGroupsClosed': True, 'matchingPublicRowVerified': False,
                'metadataImported': False, 'providerCalls': 0, 'emails': 0, 'productionReady': False,
                'globalAutomationPaused': True}}
        for name, record in self.records.items():
            handoff.write_exclusive(self.directory / name, record)
        f.metadata['tokens'][1]['expiresAt'] = handoff.utc_after(now, 7200)
        f.metadata_path.write_text(handoff.canonical(f.metadata) + '\n')

    def ask(self, prompt):
        self.prompts.append(prompt)
        if 'PUBLIC RECORD READY' in prompt:
            self.stage()
            return 'PUBLIC RECORD READY'
        if 'CONFIRM PUBLIC FACTS ' in prompt:
            return prompt.split('Type ', 1)[1].split(' to ', 1)[0]
        return self.f.ask(prompt)

    def invoke(self, ask=None):
        return self.f.invoke_with_public_input(ask or self.ask, self.messages)

    def test_consolidated_flow_imports_original_times_without_transcription_or_issuer_call(self):
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(len(self.prompts), 4)  # setup, public readiness, combined review, exact session
        self.assertFalse(any('ISSUED' in p or 'UNREVOKED' in p or 'MATCHED' in p or 'issuance start UTC' in p for p in self.prompts))
        receipt = handoff.read_public(self.f.root / 'issuance-receipt.json')
        self.assertEqual(receipt['issuanceStartedAt'], self.records['creator-result.json']['startedAt'])
        self.assertEqual(receipt['issuanceCompletedAt'], self.records['creator-result.json']['completedAt'])
        self.assertEqual(receipt['tokenName'], 'p10b-runtime-no-email-' + self.f.recipe['nonce'])
        self.assertEqual(self.f.token_calls, 1)
        self.assertTrue(all('tokens' not in args for args, _, _ in self.f.calls))
        review = handoff.read_public(self.f.root / 'owner-public-input-review.json')
        self.assertEqual(len(review['sourceSha256']), 5)
        self.assertEqual(review['ownerAttested'], True)
        self.assertNotIn('offline-private-token', '\n'.join(self.messages))
        self.assertNotIn('older-public-id', '\n'.join(self.messages))

    def test_bad_or_changed_staged_receipt_never_reaches_private_input(self):
        for mode in ['permission', 'recipe', 'creator-failed', 'unclosed', 'not-normal', 'bool-exit',
                     'elapsed', 'chronology', 'marker-upgrade', 'extra', 'changed-after-review', 'metadata-change', 'recipe-file-change', 'permission-file-change']:
            with self.subTest(mode=mode):
                self.setUp()
                def ask(prompt):
                    if 'PUBLIC RECORD READY' in prompt:
                        if mode == 'permission-file-change':
                            permission_file = self.f.root / 'private-setup-scope.json'
                            permission = handoff.read_public(permission_file)
                            permission['approvedAt'] = handoff.utc_after(permission['approvedAt'], -5)
                            permission_file.write_text(handoff.canonical(permission) + '\n')
                        self.stage()
                        if mode == 'recipe-file-change':
                            with self.f.recipe_path.open('a') as stream: stream.write(' ')
                        file = 'creator-result.json'
                        record = self.records[file]
                        if mode == 'permission':
                            file = 'intent.json'; record = self.records[file]; record['setupPermissionSha256'] = '0' * 64
                        if mode == 'recipe':
                            file = 'intent.json'; record = self.records[file]; record['recipeDigest'] = '0' * 64
                        if mode == 'creator-failed': record['success'] = False
                        if mode == 'unclosed': record['closedWithoutSignals'] = False
                        if mode == 'not-normal': record['normalReturn'] = False
                        if mode == 'bool-exit': record['exitCode'] = False
                        if mode == 'elapsed': record['elapsedMonotonicMs'] = 60001
                        if mode == 'chronology': record['startedAt'] = handoff.utc_after(record['startedAt'], -60)
                        if mode == 'marker-upgrade':
                            file = 'public-staging-ready.json'; record = self.records[file]; record['metadataImported'] = True
                        if mode == 'extra': record['rawError'] = 'synthetic-private-canary'
                        (self.directory / file).write_text(handoff.canonical(record) + '\n')
                        return 'PUBLIC RECORD READY'
                    if 'CONFIRM PUBLIC FACTS ' in prompt:
                        if mode == 'changed-after-review':
                            with (self.directory / 'list-result.json').open('a') as stream: stream.write(' ')
                        if mode == 'metadata-change':
                            self.f.metadata['tokens'][1]['tokenId'] = 'different-public-id'
                            self.f.metadata_path.write_text(handoff.canonical(self.f.metadata) + '\n')
                        return prompt.split('Type ', 1)[1].split(' to ', 1)[0]
                    return self.f.ask(prompt)
                self.assertEqual(self.invoke(ask), 2)
                self.assertEqual(self.f.token_calls, 0)
                self.assertFalse((self.f.root / 'issuance-receipt.json').exists())
                self.assertNotIn('synthetic-private-canary', '\n'.join(self.messages))

    def test_metadata_directory_swap_cannot_pair_another_row_with_original_hash(self):
        from unittest.mock import patch
        import copy
        handoff.write_exclusive(self.f.root / 'private-setup-scope.json', {'approvedAt': handoff.utc_now()})
        self.stage()
        original = self.f.root
        displaced = original.with_name(original.name + '-displaced')
        alternate = original.with_name(original.name + '-alternate')
        alternate.mkdir(mode=0o700)
        self.addCleanup(legacy.shutil.rmtree, alternate)
        metadata = copy.deepcopy(self.f.metadata)
        metadata['tokens'][1]['tokenId'] = 'different-public-id'
        handoff.write_exclusive(alternate / 'public-token-metadata.json', metadata)
        real_open = os.open
        def swapped(file, flags, *args, **kwargs):
            if isinstance(file, str) and file == str(original) and flags & os.O_DIRECTORY:
                original.rename(displaced); alternate.rename(original)
                try: return real_open(file, flags, *args, **kwargs)
                finally: original.rename(alternate); displaced.rename(original)
            return real_open(file, flags, *args, **kwargs)
        with patch.object(handoff.os, 'open', side_effect=swapped):
            with self.assertRaises(handoff.PublicInputHold):
                handoff.import_owner_public_issuance(self.f.recipe, legacy.fixture_digest(self.f.recipe),
                                                     original / 'private-setup-scope.json')

    def test_unsafe_partial_or_missing_owner_records_hold_without_fallback_or_private_input(self):
        for mode in ['symlink', 'fifo', 'hardlink', 'oversized', 'permissions', 'duplicate-json',
                     'unsafe-directory', 'metadata-hardlink', 'missing-after-ready']:
            with self.subTest(mode=mode):
                self.setUp()
                prompts = []
                def ask(prompt):
                    prompts.append(prompt)
                    if 'PUBLIC RECORD READY' in prompt:
                        if mode == 'missing-after-ready': return 'PUBLIC RECORD READY'
                        self.stage()
                        file = self.directory / 'creator-result.json'
                        if mode in ('symlink', 'fifo', 'hardlink'):
                            raw = file.read_bytes(); file.unlink()
                            if mode == 'symlink': file.symlink_to(self.f.metadata_path)
                            if mode == 'fifo': os.mkfifo(file, 0o600)
                            if mode == 'hardlink':
                                other = self.f.root / 'public-copy.json'; other.write_bytes(raw); other.chmod(0o600)
                                os.link(other, file)
                        if mode == 'oversized': file.write_bytes(b' ' * 65537)
                        if mode == 'permissions': file.chmod(0o644)
                        if mode == 'duplicate-json': file.write_text('{"success":true,"success":true}')
                        if mode == 'unsafe-directory': self.directory.chmod(0o755)
                        if mode == 'metadata-hardlink': os.link(self.f.metadata_path, self.f.root / 'metadata-alias.json')
                        return 'PUBLIC RECORD READY'
                    if 'CONFIRM PUBLIC FACTS ' in prompt:
                        return prompt.split('Type ', 1)[1].split(' to ', 1)[0]
                    return self.f.ask(prompt)
                self.assertEqual(self.invoke(ask), 2)
                self.assertEqual(self.f.token_calls, 0)
                self.assertEqual(sum('PUBLIC RECORD READY' in p for p in prompts), 1)
                self.assertFalse(any('ISSUED' in p for p in prompts))
                if mode == 'missing-after-ready': self.assertFalse(self.directory.exists())

    def test_wrong_combined_confirmation_cannot_authorize_private_entry(self):
        def ask(prompt):
            if 'CONFIRM PUBLIC FACTS ' in prompt: return 'CONFIRM PUBLIC FACTS ' + '0' * 64
            return self.ask(prompt)
        self.assertEqual(self.invoke(ask), 2)
        self.assertEqual(self.f.token_calls, 0)


class RealComponentTTYTests(unittest.TestCase):
    """Real owner wrapper capture + TTY + actual Node validation/sealing.

    Only creator/list commands, external preflight responses and the runtime
    execution boundary are synthetic. No production issuer entry is executed.
    """
    def setUp(self):
        import tempfile
        self.temp = tempfile.TemporaryDirectory(prefix='p10b-consolidated-tty-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.node = legacy.shutil.which('node')
        self.helper = Path(__file__).resolve().parent / 'helpers/p10bConsolidatedPreflightFixture.mjs'
        legacy.subprocess.run([self.node, str(self.helper), '--fixture', str(self.root)] +
                              (['--diagnostic'] if getattr(self, 'diagnostic_mode', False) else []), check=True,
                              capture_output=True, timeout=15)
        self.recipe = handoff.read_public(self.root / 'recipe.json')
        self.secret = 'fm2_SYNTHETIC_OWNER_TTY_CREDENTIAL'
        self.driver = self.root / 'handoff-driver.py'
        self.driver.write_text('''import importlib.util,json,pathlib,sys,hashlib
spec=importlib.util.spec_from_file_location('handoff',sys.argv[1]);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
root=pathlib.Path(sys.argv[2]);node=sys.argv[3];helper=sys.argv[4];recipe=json.loads((root/'recipe.json').read_text())
def runner(args,environment,timeout):
 mode=next(item for item in args if item in ['--check-only','--validate-input','--prepare','--execute'])
 if mode=='--execute' and recipe['version']=='p10b-owner-stopped-update-recipe-v2':
  assert pathlib.Path(args[1]).name=='run-p10b-stopped-update-diagnostic.js'
  assert args[-1]==recipe['files']['diagnosticNative']['path']
 result=h.run_command([node,helper,mode,str(root)],environment,timeout)
 return result
sys.exit(h.run_owner(root/'recipe.json',runner=runner,expected_recipe_sha256=hashlib.sha256((root/'recipe.json').read_bytes()).hexdigest(),bootstrap=lambda _p,_s:recipe))
''')
        self.children = []
        self.addCleanup(self.close_children)

    def close_children(self):
        for proc, master in self.children:
            if proc.poll() is None:
                proc.kill()
                self.drain((proc, master, bytearray()))
            else: proc.wait(timeout=5)
            try: os.close(master)
            except OSError: pass

    def launch(self, argv, extra_environment=None):
        master, slave = legacy.pty.openpty()
        def console():
            os.setsid()
            legacy.fcntl.ioctl(0, legacy.termios.TIOCSCTTY, 0)
        env = {'PATH': str(Path(self.node).parent) + ':/usr/bin:/bin', 'HOME': '/tmp',
               'PYTHONDONTWRITEBYTECODE': '1'}
        env.update(extra_environment or {})
        proc = legacy.subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave,
                                      env=env, preexec_fn=console, close_fds=True)
        os.close(slave)
        self.children.append((proc, master))
        return proc, master, bytearray()

    def until(self, child, marker, timeout=25):
        proc, master, output = child
        end = legacy.time.monotonic() + timeout
        while marker not in output and legacy.time.monotonic() < end:
            readable, _, _ = legacy.select.select([master], [], [], 0.1)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                    if not chunk: break
                    output.extend(chunk)
                except OSError: break
            if proc.poll() is not None and not readable: break
        self.assertIn(marker, output, bytes(output[-3000:]))
        return output

    def drain(self, child):
        # TCSAFLUSH on the private TTY may wait for output to drain. Read while
        # waiting for exit, rather than deadlocking the child's console close.
        proc, master, output = child
        end = legacy.time.monotonic() + 25
        while legacy.time.monotonic() < end:
            readable, _, _ = legacy.select.select([master], [], [], 0.05)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                    if not chunk: break
                    output.extend(chunk)
                except OSError: break
            if proc.poll() is not None and not readable: break
        proc.wait(timeout=1)
        return proc.returncode, bytes(output)

    def owner_issue_synthetic_once(self):
        # Exact reviewed source snapshot, imported without running main(). Its
        # production CLI argv and consumed package bindings are never invoked.
        source = Path(__file__).resolve().parent / 'fixtures/p10b-reviewed-owner-issue-once.py.txt'
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),
                         '5e4ce59add77c4d6d6175a5bf1440e6de5091ecabb8a4d90726c0d8ecf5d48a9')
        script = self.root / 'synthetic-owner-operation.py'
        script.write_text('''import importlib.util,importlib.machinery,json,pathlib,sys
loader=importlib.machinery.SourceFileLoader('reviewed_owner_wrapper',sys.argv[1]);spec=importlib.util.spec_from_loader(loader.name,loader);w=importlib.util.module_from_spec(spec);loader.exec_module(w)
root=pathlib.Path(sys.argv[2]);r=json.loads((root/'recipe.json').read_text());p=json.loads((root/'private-setup-scope.json').read_text())
w.DIGEST=p['recipeDigest'];w.NONCE=r['nonce'];w.NAME='p10b-runtime-no-email-'+r['nonce']
creator=[sys.executable,'-c',"import os;print(os.environ['P10B_SYNTHETIC_CREATOR_SECRET'])"]
listing=[sys.executable,'-c',"import json,pathlib,datetime as dt;r=json.loads(pathlib.Path('creator-result.json').read_text());expiry=(dt.datetime.fromisoformat(r['startedAt'].replace('Z','+00:00'))+dt.timedelta(hours=2)).isoformat(timespec='milliseconds').replace('+00:00','Z');print('ID | Name | ExpiresAt | RevokedAt');print('offline-public-id | "+w.NAME+" | '+expiry+' | null')"]
w.issue_once(pathlib.Path(r['ownerIssuanceDirectory']),lambda:None,lambda:w.check_permission(root),creator,listing)
input('SYNTHETIC_OWNER_DONE')
''')
        child = self.launch([handoff.sys.executable, str(script), str(source), str(self.root)],
                            {'P10B_SYNTHETIC_CREATOR_SECRET': self.secret})
        self.until(child, b'SYNTHETIC_OWNER_DONE')
        os.write(child[1], b'\n')
        code, private_output = self.drain(child)
        self.assertEqual(code, 0, private_output)
        self.assertIn(self.secret.encode(), private_output)
        directory = Path(self.recipe['ownerIssuanceDirectory'])
        row = (directory / 'owner-public-token-listing.txt').read_text().splitlines()[1].split(' | ')
        handoff.write_exclusive(self.root / 'public-token-metadata.json', {
            'version': 'p10b-owner-token-metadata-v1', 'app': self.recipe['app'],
            'tokens': [{'tokenId': row[0], 'tokenName': row[1], 'expiresAt': row[2], 'revokedAt': None}]})
        for file in directory.iterdir():
            self.assertNotIn(self.secret.encode(), file.read_bytes())
        return directory

    def run_journey(self, mode):
        import re
        child = self.launch([handoff.sys.executable, str(self.driver), str(legacy.SOURCE), str(self.root), self.node, str(self.helper)])
        output = self.until(child, b'APPROVE PRIVATE SETUP ')
        setup_digest = re.findall(rb'APPROVE PRIVATE SETUP ([a-f0-9]{64})', output)[-1]
        os.write(child[1], b'APPROVE PRIVATE SETUP ' + setup_digest + b'\n')
        self.until(child, b'Type PUBLIC RECORD READY')
        directory = self.owner_issue_synthetic_once()
        os.write(child[1], b'PUBLIC RECORD READY\n')
        output = self.until(child, b' to attest successful owner issuance')
        review_digest = re.findall(rb'CONFIRM PUBLIC FACTS ([a-f0-9]{64})', output)[-1]
        if mode == 'public-drift':
            with (directory / 'list-result.json').open('a') as stream: stream.write(' ')
        os.write(child[1], (self.secret.encode() if mode == 'secret-at-review' else b'CONFIRM PUBLIC FACTS ' + review_digest) + b'\n')
        if mode in ('public-drift', 'secret-at-review'):
            code, output = self.drain(child)
            self.assertEqual(code, 2)
            self.assertNotIn(b'Temporary isolated app token', output)
        else:
            self.until(child, b'Temporary isolated app token (hidden): ')
            if mode == 'preflight-failure': (self.root / 'inject-preflight-failure').touch()
            os.write(child[1], self.secret.encode() + b'\n')
            if mode == 'preflight-failure':
                code, output = self.drain(child)
                self.assertEqual(code, 2)
                self.assertFalse((self.root / 'sealed-session.json').exists())
            else:
                output = self.until(child, b' to authorize this exact ')
                prefix = b'APPROVE CONDITIONAL STOPPED UPDATE ' if getattr(self, 'diagnostic_mode', False) else b'APPROVE SESSION '
                self.assertIn(prefix, output)
                session_digest = re.findall(re.escape(prefix) + rb'([a-f0-9]{64})', output)[-1]
                sealed = handoff.read_public(self.root / 'sealed-session.json')
                self.assertEqual(sealed['approval']['sessionDigest'], session_digest.decode())
                self.assertFalse(sealed['approval']['approved'])
                if getattr(self, 'diagnostic_mode', False):
                    self.assertEqual(sealed['version'], 'p10b-stopped-update-bundle-v2')
                    self.assertEqual(sealed['session']['version'], 'p10b-stopped-update-session-v2')
                    self.assertEqual(sealed['approval']['version'], 'p10b-stopped-update-approval-v2')
                    self.assertEqual(sealed['session']['recoveryPolicy'], 'acknowledged-only-nonrunning-v1')
                    self.assertIn(b'acknowledged-only-nonrunning-v1', output)
                    self.assertIn(b'created or stopped', output)
                    self.assertIn(b'timely valid primary acknowledgement', output)
                    self.assertIn(b'version-scoped settlement', output)
                    self.assertIn(b'no automatic restoration', output)
                    self.assertIn(b'separately approved recovery', output)
                closure = handoff.read_public(self.root / 'runtime-evidence/p10b-owner-preflight-closure.json')
                self.assertTrue(closure['reaped'] and closure['cleanupVerified'])
                self.assertFalse(Path(closure['privateAuthDirectory']).exists())
                consent = prefix + session_digest + b'\n'
                if mode == 'decline-session': consent = b'\n'
                if mode == 'old-diagnostic-consent': consent = b'APPROVE STOPPED UPDATE ' + session_digest + b'\n'
                os.write(child[1], consent)
                code, output = self.drain(child)
                self.assertEqual(code, 2 if mode in ('decline-session', 'old-diagnostic-consent') else 0, output[-3000:])
                if mode == 'success':
                    approved = handoff.read_public(self.root / 'approved-session.json')
                    boundary = handoff.read_public(self.root / 'execution-boundary.json')
                    self.assertEqual(approved['session'], sealed['session'])
                    if getattr(self, 'diagnostic_mode', False):
                        final = handoff.read_public(self.root / 'owner-final-approval.json')
                        self.assertEqual(final['version'], 'p10b-owner-final-stopped-update-approval-v2')
                    self.assertEqual(boundary['sessionDigest'], session_digest.decode())
                    self.assertTrue(boundary['runtimeSimulated'])
                    self.assertEqual(approved['session']['authenticationEvidence']['issuanceStartedAt'],
                                     handoff.read_public(directory / 'creator-result.json')['startedAt'])
                else: self.assertFalse((self.root / 'approved-session.json').exists())
        self.assertNotIn(self.secret.encode(), output)
        for file in self.root.rglob('*'):
            if file.is_file(): self.assertNotIn(self.secret.encode(), file.read_bytes(), str(file))
        terminal = handoff.read_public(self.root / 'owner-terminal.json')
        self.assertEqual(terminal['credentialInputRequested'], mode not in ('public-drift', 'secret-at-review'))
        if mode != 'success': self.assertFalse((self.root / 'execution-boundary.json').exists())
        return child

    def test_actual_private_ttys_and_real_preflight_seal_exact_approval_without_creator_output_capture(self):
        self.run_journey('success')
        before = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        replay = self.launch([handoff.sys.executable, str(self.driver), str(legacy.SOURCE), str(self.root), self.node, str(self.helper)])
        code, output = self.drain(replay)
        self.assertEqual(code, 2)
        self.assertNotIn(b'Temporary isolated app token', output)
        self.assertEqual(before, {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_child_imports_do_not_create_untracked_bytecode_in_source_directories(self):
        modules = self.root / 'public-module-fixture'
        modules.mkdir()
        (modules / 'public_fixture.py').write_text('PUBLIC_VALUE = 1\n')
        child = self.launch([handoff.sys.executable, '-c',
            'import sys; sys.path.insert(0, sys.argv[1]); import public_fixture; assert public_fixture.PUBLIC_VALUE == 1',
            str(modules)])
        code, output = self.drain(child)
        self.assertEqual(code, 0, output)
        self.assertFalse((modules / '__pycache__').exists())

    def test_refusal_drift_and_actual_preflight_failure_do_not_cross_approval_boundary(self):
        for mode in ['public-drift', 'secret-at-review', 'preflight-failure', 'decline-session']:
            with self.subTest(mode=mode):
                self.setUp()
                self.run_journey(mode)


if __name__ == '__main__':
    unittest.main()
