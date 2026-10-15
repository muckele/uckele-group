#!/usr/bin/env python3
"""Private owner entry. Imports/check-only never accept credentials or use SDKs."""
import argparse
from contextlib import contextmanager
import datetime as dt
import errno
import getpass
import hashlib
import json
import os
import re
from pathlib import Path
import selectors
import shlex
import signal
import stat
import subprocess
import sys
import termios
import time
import warnings

SCRIPTS = Path(__file__).resolve().parent


class Hold(Exception):
    pass


class PublicInputHold(Hold):
    def __init__(self, field, code):
        self.field = field
        self.code = code
        super().__init__('Public input held')


class PublicMetadataNotReady(PublicInputHold):
    def __init__(self, directory_identity):
        self.directory_identity = directory_identity
        super().__init__('public-token-metadata', 'PUBLIC_METADATA_NOT_READY')


@contextmanager
def private_owner_console():
    # getpass uses the controlling tty. Keep echo disabled between prompts too,
    # then discard queued paste before restoring the owner's terminal mode.
    descriptor = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
    previous = None
    handlers = {}
    def terminate(_number, _frame):
        raise Hold('Private owner entry terminated')
    try:
        if not os.isatty(descriptor):
            raise Hold('Private controlling terminal required')
        for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
            handlers[number] = signal.getsignal(number)
            signal.signal(number, terminate)
        # Preserve ordinary KeyboardInterrupt while reading, but prevent a
        # second interrupt from cutting short the final queued-input flush.
        handlers[signal.SIGINT] = signal.getsignal(signal.SIGINT)
        previous = termios.tcgetattr(descriptor)
        masked = list(previous)
        masked[3] &= ~termios.ECHO
        termios.tcsetattr(descriptor, termios.TCSAFLUSH, masked)
        yield
    finally:
        # Block the whole set atomically: sequential per-signal changes leave
        # a window where a second termination can skip the queued-input flush.
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, set(handlers))
        try:
            if previous is not None:
                # On an uncertain flush, do not turn echo back on over queued
                # input. Caller records a fixed closure hold, never raw errors.
                termios.tcflush(descriptor, termios.TCIFLUSH)
                termios.tcsetattr(descriptor, termios.TCSAFLUSH, previous)
        finally:
            try:
                os.close(descriptor)
            finally:
                try:
                    for number, handler in handlers.items():
                        signal.signal(number, handler)
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def masked_owner_input(prompt):
    descriptor = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
    try:
        termios.tcflush(descriptor, termios.TCIFLUSH)
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            return getpass.getpass(prompt)
    finally:
        try:
            termios.tcflush(descriptor, termios.TCIFLUSH)
        finally:
            os.close(descriptor)


def read_public_input(ask, field, prompt, emit, normalize, invalid_code):
    # One correction of syntax only. Approval, issuance success and all later
    # authority/coverage/consumed-state checks remain one-shot.
    for attempt in range(2):
        try:
            value = ask(prompt)
        except EOFError:
            raise PublicInputHold(field, 'INPUT_ENDED') from None
        except KeyboardInterrupt:
            raise PublicInputHold(field, 'INPUT_CANCELLED') from None
        except (OSError, termios.error, getpass.GetPassWarning):
            raise PublicInputHold(field, 'PRIVATE_INPUT_UNAVAILABLE') from None
        try:
            if not isinstance(value, str) or len(value) > 256:
                raise ValueError()
            return normalize(value)
        except (ValueError, TypeError, Hold):
            # Never print or persist the rejected value or its exception.
            value = None
            emit('Public field ' + field + ' rejected: ' + invalid_code + '. Paste only this field; entry is hidden.')
            if attempt == 1:
                raise PublicInputHold(field, invalid_code) from None


def confirm_issuance(ask, emit):
    # Correct input once within this attempt; never repeat issuance or consent.
    # The production masked reader flushes queued input before/after each read;
    # any read, flush or interruption error propagates straight to closure.
    for attempt in range(2):
        value = ask('Type literal ISSUED, NOT THE TOKEN, only after that exact creation succeeds: ')
        if value == 'ISSUED':
            return
        failed = value == 'FAILED'
        value = None
        if failed or attempt == 1:
            raise Hold('No successful issuance confirmation')
        emit('Entry discarded. Type the WORD ISSUED. Paste the token only at the later hidden credential prompt. '
             'One correction only; do not create another token.')


def normalize_public_token_id(value):
    if not re.fullmatch(r'[A-Za-z0-9_:-]{1,120}', value) or value.lower().startswith(('fm1_', 'fm2_', 'bearer')):
        raise ValueError()
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def utc_after(value, seconds):
    timestamp = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if timestamp.tzinfo != dt.timezone.utc:
        raise Hold('UTC public timestamps required')
    return (timestamp + dt.timedelta(seconds=seconds)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def normalize_utc(value):
    return utc_after(value, 0)


def import_public_token_metadata(recipe, expected_directory=None, with_snapshot=False):
    # Public metadata only, prepared locally from the owner's verified listing.
    # No SDK, credential input, token decoding or identity inference occurs here.
    try:
        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        def invalid_constant(_value):
            raise ValueError()
        directory = os.open(recipe['outputDirectory'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            root = os.fstat(directory)
            if not stat.S_ISDIR(root.st_mode) or root.st_uid != os.getuid() or stat.S_IMODE(root.st_mode) != 0o700:
                raise ValueError()
            identity = (root.st_dev, root.st_ino)
            if expected_directory is not None and identity != expected_directory:
                raise ValueError()
            try:
                descriptor = os.open('public-token-metadata.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            except FileNotFoundError:
                # Only a missing leaf inside this validated directory is a
                # coordination wait. Root/file integrity failures remain fatal.
                raise PublicMetadataNotReady(identity) from None
            with os.fdopen(descriptor, 'rb') as stream:
                before = os.fstat(stream.fileno())
                if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                        or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > 65536
                        or (with_snapshot and before.st_nlink != 1)):
                    raise ValueError()
                raw = stream.read(65537)
                after = os.fstat(stream.fileno())
                if (len(raw) != before.st_size or _public_identity(before) != _public_identity(after)
                        or _public_identity(os.stat('public-token-metadata.json', dir_fd=directory,
                                                   follow_symlinks=False)) != _public_identity(before)):
                    raise ValueError()
            current_root = os.stat(recipe['outputDirectory'], follow_symlinks=False)
            if (current_root.st_dev, current_root.st_ino) != identity:
                raise ValueError()
        finally:
            os.close(directory)
        metadata = json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid_constant)
        if (not isinstance(metadata, dict) or set(metadata) != {'version', 'app', 'tokens'}
                or metadata['version'] != 'p10b-owner-token-metadata-v1' or metadata['app'] != recipe['app']
                or not isinstance(metadata['tokens'], list) or not 1 <= len(metadata['tokens']) <= 128):
            raise ValueError()
        matches, identifiers = [], set()
        for row in metadata['tokens']:
            if not isinstance(row, dict) or set(row) != {'tokenId', 'tokenName', 'expiresAt', 'revokedAt'}:
                raise ValueError()
            token_id = normalize_public_token_id(row['tokenId'])
            if token_id.lower().startswith('flyv1') or token_id in identifiers:
                raise ValueError()
            identifiers.add(token_id)
            if not isinstance(row['tokenName'], str) or not re.fullmatch(r'p10b-runtime-no-email-[a-f0-9]{24}', row['tokenName']):
                raise ValueError()
            for field in ('expiresAt', 'revokedAt'):
                if field == 'revokedAt' and row[field] is None:
                    continue
                if not isinstance(row[field], str) or len(row[field]) > 40:
                    raise ValueError()
                if normalize_utc(row[field]) != row[field]:
                    raise ValueError()
            if row['tokenName'] == 'p10b-runtime-no-email-' + recipe['nonce']:
                matches.append(row)
        if len(matches) != 1 or matches[0]['revokedAt'] is not None:
            raise ValueError()
        if with_snapshot:
            return matches[0], {'sha256': hashlib.sha256(raw).hexdigest(),
                                'fileIdentity': _public_identity(before), 'directoryIdentity': identity}
        return matches[0]
    except PublicMetadataNotReady:
        raise
    except Exception:
        raise PublicInputHold('public-token-metadata', 'INVALID_PUBLIC_METADATA') from None


def ready_public_token_metadata(recipe, ask, emit):
    try:
        return import_public_token_metadata(recipe)
    except PublicMetadataNotReady as missing:
        identity = missing.directory_identity
    emit('Public metadata is not ready. Keep the same token and original issuance times; '
         'do not create another token or rerun this launcher. Leave this prompt waiting while '
         'the helper stages verified public metadata at ' +
         str(Path(recipe['outputDirectory']) / 'public-token-metadata.json') +
         '. No credential or authentication has been requested. One explicit recheck is available.')
    if ask('Type literal METADATA READY only after the public file is prepared, NOT THE TOKEN: ') != 'METADATA READY':
        raise PublicInputHold('public-token-metadata', 'METADATA_NOT_CONFIRMED')
    return import_public_token_metadata(recipe, expected_directory=identity)


class PublicIssuanceNotReady(PublicInputHold):
    def __init__(self, parent_identity):
        super().__init__('owner-public-issuance', 'PUBLIC_ISSUANCE_NOT_READY')
        self.parent_identity = parent_identity


def _public_identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _strict_public_json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError()
            value[key] = item
        return value
    def invalid(_value):
        raise ValueError()
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)


def import_owner_public_issuance(recipe, recipe_digest, permission_path, expected_parent=None):
    # The owner-operated reviewed wrapper creates these public records. Never
    # invoke it, read its creator output, or parse its separate listing here.
    descriptors = []
    try:
        target = Path(recipe['ownerIssuanceDirectory'])
        if not target.is_absolute() or str(target) != os.path.normpath(str(target)) or target.name != 'owner-public-issuance':
            raise ValueError()
        parent = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(parent)
        parent_info = os.fstat(parent)
        if parent_info.st_uid != os.getuid() or stat.S_IMODE(parent_info.st_mode) != 0o700:
            raise ValueError()
        parent_identity = (parent_info.st_dev, parent_info.st_ino)
        if expected_parent is not None and expected_parent != parent_identity:
            raise ValueError()
        try:
            directory = os.open(target.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        except FileNotFoundError:
            raise PublicIssuanceNotReady(parent_identity) from None
        descriptors.append(directory)
        root = os.fstat(directory)
        if root.st_uid != os.getuid() or stat.S_IMODE(root.st_mode) != 0o700:
            raise ValueError()
        records, hashes, identities = {}, {}, {}
        for name in ('intent.json', 'creator-result.json', 'list-result.json', 'public-staging-ready.json'):
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            descriptors.append(descriptor)
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1
                    or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > 65536):
                raise ValueError()
            raw = os.read(descriptor, 65537)
            if len(raw) != before.st_size:
                raise ValueError()
            identities[name] = _public_identity(before)
            records[name] = _strict_public_json(raw)
            hashes[name] = hashlib.sha256(raw).hexdigest()
        for name, descriptor in zip(records, descriptors[2:]):
            if (_public_identity(os.fstat(descriptor)) != identities[name]
                    or _public_identity(os.stat(name, dir_fd=directory, follow_symlinks=False)) != identities[name]):
                raise ValueError()
        current_root = os.stat(target.name, dir_fd=parent, follow_symlinks=False)
        current_parent = os.stat(target.parent, follow_symlinks=False)
        if ((current_root.st_dev, current_root.st_ino) != (root.st_dev, root.st_ino)
                or (current_parent.st_dev, current_parent.st_ino) != parent_identity):
            raise ValueError()
        identities['directory'] = (root.st_dev, root.st_ino)
        identities['parent'] = parent_identity
        permission_raw = public_package_bytes(permission_path)
        permission = _strict_public_json(permission_raw)
        intent = records['intent.json']
        expected = {'version': 'p10b-owner-issuance-intent-v1', 'app': recipe['app'],
                    'tokenName': 'p10b-runtime-no-email-' + recipe['nonce'], 'recipeDigest': recipe_digest,
                    'setupPermissionSha256': hashlib.sha256(permission_raw).hexdigest(), 'noRetry': True,
                    'productionReady': False, 'globalAutomationPaused': True}
        if set(intent) != set(expected) | {'attemptedAt'} or any(type(intent[k]) is not type(v) or intent[k] != v for k, v in expected.items()):
            raise ValueError()
        results = []
        result_keys = {'startedAt', 'completedAt', 'exitCode', 'normalReturn', 'elapsedMonotonicMs',
                       'ownedGroupClosed', 'closedWithoutSignals', 'success'}
        for name, limit in [('creator-result.json', 60000), ('list-result.json', 30000)]:
            result = records[name]
            if (set(result) != result_keys or type(result['exitCode']) is not int or result['exitCode'] != 0
                    or any(result[key] is not True for key in ['normalReturn', 'ownedGroupClosed', 'closedWithoutSignals', 'success'])
                    or type(result['elapsedMonotonicMs']) is not int or not 0 <= result['elapsedMonotonicMs'] <= limit):
                raise ValueError()
            start, end = result['startedAt'], result['completedAt']
            if normalize_utc(start) != start or normalize_utc(end) != end:
                raise ValueError()
            if not 0 <= (dt.datetime.fromisoformat(end.replace('Z', '+00:00')) - dt.datetime.fromisoformat(start.replace('Z', '+00:00'))).total_seconds() * 1000 <= limit:
                raise ValueError()
            results.append(result)
        creator, listed = results
        marker = records['public-staging-ready.json']
        expected_marker = {'version': 'p10b-owner-public-staging-v1', 'app': recipe['app'],
            'tokenName': expected['tokenName'], 'recipeDigest': recipe_digest,
            'issuanceStartedAt': creator['startedAt'], 'issuanceCompletedAt': creator['completedAt'],
            'creationSucceeded': True, 'listSucceeded': True, 'ownedGroupsClosed': True,
            'matchingPublicRowVerified': False, 'metadataImported': False, 'providerCalls': 0, 'emails': 0,
            'productionReady': False, 'globalAutomationPaused': True}
        if set(marker) != set(expected_marker) or any(type(marker[k]) is not type(v) or marker[k] != v for k, v in expected_marker.items()):
            raise ValueError()
        chronology = [permission['approvedAt'], intent['attemptedAt'], creator['startedAt'], creator['completedAt'],
                      listed['startedAt'], listed['completedAt'], utc_now()]
        if any(normalize_utc(value) != value for value in chronology) or chronology != sorted(chronology):
            raise ValueError()
        selected, metadata_snapshot = import_public_token_metadata(recipe, with_snapshot=True)
        hashes['public-token-metadata.json'] = metadata_snapshot['sha256']
        identities['public-token-metadata.json'] = metadata_snapshot
        review = {'version': 'p10b-owner-public-review-v1', 'recipeDigest': recipe_digest,
                  'issuanceStartedAt': creator['startedAt'], 'issuanceCompletedAt': creator['completedAt'],
                  'selectedPublicToken': selected, 'sourceSha256': hashes,
                  'attestations': {'ownerIssuanceSucceeded': True, 'publicMetadataUnrevoked': True,
                                   'privateCredentialMatchesSelectedToken': True},
                  'credentialIdentityIndependentlyVerified': False}
        return review, identities
    except PublicIssuanceNotReady:
        raise
    except Exception:
        raise PublicInputHold('owner-public-issuance', 'INVALID_PUBLIC_ISSUANCE') from None
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def ready_owner_public_issuance(recipe, checked, permission_path, ask, emit):
    try:
        return import_owner_public_issuance(recipe, checked['recipeDigest'], permission_path)
    except PublicIssuanceNotReady as missing:
        identity = missing.parent_identity
    emit('Use only the separately reviewed owner-operated issuance wrapper, once, under this setup consent. '
         'It records original UTCs and a separate public listing; its creator output stays private. '
         'Have the verified public metadata staged before continuing. No credential has been requested.')
    for attempt in range(2):
        value = ask('Type PUBLIC RECORD READY only after the wrapper and public staging complete, NOT THE TOKEN: ')
        if value == 'PUBLIC RECORD READY':
            return import_owner_public_issuance(recipe, checked['recipeDigest'], permission_path, identity)
        failed = value == 'FAILED'
        value = None
        if failed or attempt == 1:
            raise PublicInputHold('owner-public-issuance', 'PUBLIC_RECORD_NOT_CONFIRMED')
        emit('Entry discarded. Type the words PUBLIC RECORD READY only after staging; one correction, no new issuance.')


def public_session_summary(bundle, summary):
    session = bundle['session']
    return {'status': 'AWAITING_EXACT_OWNER_APPROVAL', 'sessionDigest': summary['sessionDigest'],
            'completeSealedBundlePath': summary['sealedBundlePath'],
            **{key: session.get(key) for key in ('app', 'machineId', 'volumeId', 'hostSourceHead', 'sourceHead',
                'candidateImageDigest', 'baselineImageDigest', 'startedAt', 'sessionDeadline', 'maximumStarts',
                'maximumStartWindowMs', 'maximumStoppedConfigUpdates', 'maximumIncrementalUsd',
                'maximumLocalBuilds', 'maximumImagePushes', 'productionReady', 'globalAutomationPaused')},
            'tokenId': session.get('authenticationEvidence', {}).get('tokenId'),
            'tokenExpiresAt': session.get('authenticationEvidence', {}).get('expiresAt'),
            'ownerPermissionDigest': session['ownerPermissionDigest'],
            'recovery': session.get('recovery'), 'preflightCleanupVerified': summary['preflightCleanupVerified'],
            'providerCalls': 0, 'emails': 0, 'runtimeApproved': False}


def public_package_bytes(file):
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > 1048576):
            raise Hold('Bounded public package file required')
        raw = stream.read(1048577)
        after = os.fstat(stream.fileno())
        if (len(raw) > 1048576 or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise Hold('Public package file changed during read')
        return raw


def read_public(file):
    file = Path(file)
    st = file.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_size > 1048576:
        raise Hold('Bounded plain public file required')
    with file.open() as stream:
        return json.load(stream)


def write_exclusive(file, value):
    file = Path(file)
    descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(canonical(value) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(file.parent, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def hidden_token():
    warnings.simplefilter('error', getpass.GetPassWarning)
    return getpass.getpass('Temporary isolated app token (hidden): ')


def bound_file(binding, executable=False):
    path = Path(binding['path'])
    st = path.lstat()
    if not path.is_absolute() or not stat.S_ISREG(st.st_mode) or st.st_size > 268435456:
        raise Hold('Bound plain artifact required')
    if hashlib.sha256(path.read_bytes()).hexdigest() != binding['sha256'] or (executable and not os.access(path, os.X_OK)):
        raise Hold('Bootstrap artifact changed')
    return path


def bootstrap_recipe(file, expected_sha256):
    if not isinstance(expected_sha256, str) or not re.fullmatch('[a-f0-9]{64}', expected_sha256):
        raise Hold('Approved public recipe checksum required')
    path = bound_file({'path': str(Path(file).absolute()), 'sha256': expected_sha256})
    recipe = read_public(path)
    bound_file(recipe['files']['node'], executable=True)
    python = bound_file(recipe['files']['python'], executable=True)
    if python.resolve() != Path(sys.executable).resolve():
        raise Hold('Approved Python interpreter required')
    for name, actual in [('ownerScript', Path(__file__).resolve()), ('preflightScript', SCRIPTS / 'run-p10b-owner-preflight.js')]:
        if bound_file(recipe['files'][name]) != actual:
            raise Hold('Fixed reviewed entrypoint required')
    environment = {'PATH': '/usr/bin:/bin', 'HOME': recipe['ownerHome'],
                   'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
    prefix = ['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', str(SCRIPTS.parent)]
    head = subprocess.run(prefix + ['rev-parse', 'HEAD'], env=environment, capture_output=True, text=True, check=True, timeout=10)
    dirty = subprocess.run(prefix + ['status', '--porcelain'], env=environment, capture_output=True, text=True, check=True, timeout=10)
    if head.stdout.strip() != recipe['hostSourceHead'] or dirty.stdout.strip():
        raise Hold('Clean reviewed bootstrap source required')
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected_sha256:
        raise Hold('Recipe changed during bootstrap')
    return recipe


def settle_owned_group(child):
    # Signal before wait/reaping the leader, retaining ownership of its PGID even
    # when it exited while descendants kept pipes or closed their own stdio.
    term_deadline = time.monotonic() + 2
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError as error:
        # Darwin returns EPERM for an exited, unreaped group leader. Resolve
        # only that case: exact child exit AND positive absence of its group.
        # Do not signal again after a permission failure or treat it as absence.
        if error.errno == errno.EPERM:
            try:
                code = child.wait(timeout=0)
            except (subprocess.TimeoutExpired, OSError):
                raise Hold('Owned subprocess group termination unverified')
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                return code
            except OSError:
                raise Hold('Owned subprocess group closure unverified')
        raise Hold('Owned subprocess group termination unverified')
    try:
        code = child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        code = child.wait(timeout=2)
    def absent():
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            raise Hold('Owned subprocess group closure unverified')
        return False
    while time.monotonic() < term_deadline:
        if absent():
            return code
        time.sleep(0.025)
    if not absent():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            raise Hold('Owned subprocess group termination unverified')
    end = time.monotonic() + 1
    while time.monotonic() < end:
        if absent():
            return code
        time.sleep(0.025)
    raise Hold('Owned subprocess group closure unverified')


def run_command(args, environment, timeout):
    # No shell; only reviewed Node entrypoints. Bound all output and wall time.
    child = subprocess.Popen(args, env=environment, cwd=SCRIPTS.parent,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    streams = selectors.DefaultSelector()
    streams.register(child.stdout, selectors.EVENT_READ, 'stdout')
    streams.register(child.stderr, selectors.EVENT_READ, 'stderr')
    output = bytearray()
    total = 0
    end = time.monotonic() + timeout
    settling = False
    try:
        while streams.get_map():
            left = end - time.monotonic()
            if left <= 0:
                raise Hold('Reviewed local command timed out')
            for key, _ in streams.select(min(0.1, left)):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    streams.unregister(key.fileobj)
                    continue
                total += len(data)
                if total > 2097152:
                    raise Hold('Reviewed local output bound exceeded')
                if key.data == 'stdout':
                    output.extend(data)
        settling = True
        code = settle_owned_group(child)
        if code != 0:
            raise Hold('Reviewed local command held')
        return json.loads(output)
    except BaseException:
        if not settling:
            settling = True
            settle_owned_group(child)
        raise
    finally:
        streams.close()
        child.stdout.close()
        child.stderr.close()


def check_recipe(file, runner=run_command, expected_recipe_sha256=None, bootstrap=bootstrap_recipe):
    recipe = bootstrap(file, expected_recipe_sha256)
    environment = {'PATH': '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', 'HOME': recipe['ownerHome']}
    result = runner([recipe['files']['node']['path'], str(SCRIPTS / 'run-p10b-owner-preflight.js'),
                     '--check-only', '--recipe', str(file)], environment, 30)
    if result.get('status') != 'STATIC_READY_FOR_SEPARATELY_APPROVED_PRIVATE_SETUP' or not re.fullmatch('[a-f0-9]{64}', result.get('recipeDigest', '')) or result.get('recipeFileSha256') != expected_recipe_sha256:
        raise Hold('Exact static recipe not ready')
    return recipe, result, environment


def run_owner(recipe_file, runner=run_command, ask=None, token_input=hidden_token,
              private_tty=lambda: sys.stdin.isatty() and sys.stderr.isatty(), emit=print,
              expected_recipe_sha256=None, bootstrap=bootstrap_recipe):
    environment = None
    recipe = None
    success = False
    phase = 'static-check'
    console = None
    public_input_field = None
    public_input_error = None
    credential_input_requested = False
    authenticated_preflight_requested = False
    try:
        recipe, checked, environment = check_recipe(recipe_file, runner, expected_recipe_sha256, bootstrap)
        root = Path(recipe['outputDirectory'])
        for name in ('private-setup-scope.json', 'issuance-receipt.json', 'owner-terminal.json',
                     'owner-final-approval.json', 'sealed-session.json', 'approved-session.json', 'owner-public-input-review.json'):
            if (root / name).exists():
                raise Hold('Existing evidence preserved; owner entry already consumed')
        if not private_tty():
            raise Hold('Private unrecorded terminal required')
        if ask is None:
            console = private_owner_console()
            console.__enter__()
            ask = masked_owner_input
        phase = 'setup-approval'
        emit(json.dumps(checked, indent=2))
        price = read_public(recipe['files']['price']['path'])
        emit(json.dumps({key: price.get(key) for key in ('observedAt', 'source', 'ewrShared1Cpu512MbPer30DaysUsd',
             'tenMinuteComputeEstimateUsd', 'volumeUsdPerProvisionedGbMonth', 'stoppedRootfsUsdPerGbMonth',
             'snapshotsUsdPerStoredGbMonth', 'northAmericaEgressUsdPerGb', 'registrySeparateChargeVerified',
             'oneUsdIsBillingCap', 'retainedStorageContinues')}, indent=2))
        emit('Existing 1 GB volume remains charged while stopped. Actual rootfs GB is unknown; separate registry '
             'charges remain unverified. Historical snapshot count zero has not been rechecked. No new storage/capacity.')
        emit('This requires separate owner approval for private app-token setup, fixed-target read-only '
             'preflight and exclusive historical archival recovery. Final runtime approval follows sealed facts. '
             'No provider calls/email, no auth renewal. The $1 operational budget is not a billing cap; '
             'retained storage continues. Temporary 0700 Fly/Docker disk state may contain credentials; '
             'uncertain cleanup is retained. Manually revoke only this new matching token after closed clients.')
        phrase = 'APPROVE PRIVATE SETUP ' + checked['recipeDigest']
        if ask('Type ' + phrase + ': ') != phrase:
            raise Hold('Private setup declined')
        permission = {'version': 'p10b-owner-private-setup-v1', 'approved': True, 'recipeDigest': checked['recipeDigest'],
                      'approvedAt': utc_now(), 'providerCalls': 0, 'emails': 0, 'productionReady': False,
                      'globalAutomationPaused': True, 'exclusiveAdmissionWriters': True, 'recoveryApproved': True}
        permission_path = root / 'private-setup-scope.json'
        write_exclusive(permission_path, permission)
        phase = 'public-issuance'
        if 'ownerIssuanceDirectory' in recipe:
            review, identities = ready_owner_public_issuance(recipe, checked, permission_path, ask, emit)
            emit('Owner-attested public facts; opaque credential identity is not independently verified:')
            emit(json.dumps(review, indent=2))
            public_digest = hashlib.sha256(canonical(review).encode()).hexdigest()
            phrase = 'CONFIRM PUBLIC FACTS ' + public_digest
            if ask('Type ' + phrase + ' to attest successful owner issuance, unrevoked metadata and matching private credential: ') != phrase:
                raise Hold('Public facts declined')
            repeated, repeated_identities = import_owner_public_issuance(recipe, checked['recipeDigest'], permission_path)
            if repeated != review or repeated_identities != identities:
                raise Hold('Public facts changed after review')
            write_exclusive(root / 'owner-public-input-review.json', {**review, 'publicReviewDigest': public_digest,
                            'ownerAttested': True, 'approvedAt': utc_now()})
            started, completed = review['issuanceStartedAt'], review['issuanceCompletedAt']
            selected = review['selectedPublicToken']
        else:
            name = 'p10b-runtime-no-email-' + recipe['nonce']
            fly_command = ['/usr/bin/env', '-u', 'FLY_UPDATE_CHECK', 'FLY_NO_UPDATE_CHECK=1', recipe['files']['fly']['path']]
            emit('Only now, in a separate private unrecorded owner terminal, record UTC immediately before '
                 'and after successful issuance (within 60 seconds), and personally run:')
            emit(shlex.join(fly_command + ['tokens', 'create', 'deploy', '--app', recipe['app'], '--expiry', '2h', '--name', name]))
            emit('Keep its printed credential private. Obtain the matching public ID/name/actual effective '
                 'expiry/unrevoked metadata from the app Tokens dashboard, or run this separate read-only command '
                 'only after successful issuance:')
            emit(shlex.join(fly_command + ['tokens', 'list', '--app', recipe['app'], '--scope', 'app']))
            emit('Both commands use the checksum-bound executable and disable update checks; never substitute bare fly. '
                 'No retry/login/renewal is authorized by this handoff.')
            emit('Paste one public field at a time. Never paste combined timestamp/token output. '
                 'Public entry is hidden to protect accidental private paste.')
            emit('Before confirming ISSUED, have the public metadata helper prepare public-token-metadata.json '
                 'in this package from the verified matching public listing. Never share the credential in chat. '
                 'The local import selects ID and expiry; no manual ID/expiry entry or authenticated lookup.')
            confirm_issuance(ask, emit)
            started = read_public_input(ask, 'issuance-start-utc', 'Actual successful issuance start UTC: ', emit, normalize_utc, 'INVALID_UTC')
            completed = read_public_input(ask, 'issuance-completion-utc', 'Actual successful issuance completion UTC: ', emit, normalize_utc, 'INVALID_UTC')
            selected = ready_public_token_metadata(recipe, ask, emit)
        if (hashlib.sha256(public_package_bytes(recipe_file)).hexdigest() != expected_recipe_sha256
                or public_package_bytes(permission_path) != (canonical(permission) + '\n').encode()):
            raise Hold('Original public setup bindings changed')
        name = selected['tokenName']
        token_id, expiry = selected['tokenId'], selected['expiresAt']
        if 'ownerIssuanceDirectory' not in recipe:
            emit('Selected owner-attested public token metadata; opaque credential identity is not independently verified:')
            emit(json.dumps({'app': recipe['app'], **selected}, indent=2))
            if ask('Type literal UNREVOKED after checking the displayed matching metadata: ') != 'UNREVOKED':
                raise Hold('Public revocation status not attested')
            if ask('Type literal MATCHED to attest private input matches this displayed exact new app-deploy token: ') != 'MATCHED':
                raise Hold('Private selection not attested')
        receipt = {'version': 'p10b-app-token-issuance-v1', 'ownerAttested': True, 'issuanceSucceeded': True,
                   'app': recipe['app'], 'scope': 'app-deploy', 'tokenId': token_id, 'tokenName': name,
                   'issuanceEvidenceId': 'private-owner:' + recipe['nonce'], 'issuanceStartedAt': started,
                   'issuanceCompletedAt': completed, 'requestedLifetimeMs': 7200000, 'revokedAt': None, 'expiresAt': expiry}
        receipt_path = root / 'issuance-receipt.json'
        write_exclusive(receipt_path, receipt)
        phase = 'public-input-admission'
        validated = runner([recipe['files']['node']['path'], str(SCRIPTS / 'run-p10b-owner-preflight.js'), '--validate-input',
                            '--recipe', str(recipe_file), '--receipt', str(receipt_path), '--permission', str(permission_path)], environment, 30)
        if validated.get('status') != 'PUBLIC_INPUTS_VALIDATED' or validated.get('sessionNotStarted') is not True:
            raise Hold('Public scope/issuance evidence failed before hidden input')
        phase = 'hidden-entry'
        credential_input_requested = True
        token = token_input()
        if not isinstance(token, str) or not token.strip() or len(token) > 16384 or any(ord(c) < 32 or ord(c) == 127 for c in token):
            raise Hold('Opaque hidden input invalid')
        environment['FLY_API_TOKEN'] = token
        phase = 'read-only-preflight'
        authenticated_preflight_requested = True
        summary = runner([recipe['files']['node']['path'], str(SCRIPTS / 'run-p10b-owner-preflight.js'), '--prepare',
                          '--recipe', str(recipe_file), '--receipt', str(receipt_path), '--permission', str(permission_path)],
                         environment, 125)
        if summary.get('status') != 'AWAITING_EXACT_OWNER_APPROVAL' or summary.get('preflightCleanupVerified') is not True:
            raise Hold('Preflight cleanup not proved')
        sealed_path = Path(recipe['sealedBundlePath'])
        bundle = read_public(sealed_path)
        session_canonical = summary['sessionCanonical']
        if hashlib.sha256(sealed_path.read_bytes()).hexdigest() != summary['sealedBundleSha256'] or hashlib.sha256(session_canonical.encode()).hexdigest() != summary['sessionDigest'] or json.loads(session_canonical) != bundle['session']:
            raise Hold('Sealed public facts changed')
        phase = 'final-approval'
        emit(json.dumps(public_session_summary(bundle, summary) if 'ownerIssuanceDirectory' in recipe else bundle, indent=2))
        emit('Original one-hour deadline: ' + summary['sessionDeadline'] + '. Review these exact public facts; '
             'remaining time is not renewed. At most two five-minute starts and three stopped updates including '
             'restore. No host stop/retry, additional build/push, provider call, email or production change.')
        phrase = 'APPROVE SESSION ' + summary['sessionDigest']
        if ask('Type ' + phrase + ' to authorize this exact bounded no-email runtime: ') != phrase:
            raise Hold('Concrete runtime declined')
        final_approval = {'version': 'p10b-owner-final-approval-v1', 'approvedAt': utc_now(),
                          'sessionDigest': summary['sessionDigest'], 'recipeDigest': checked['recipeDigest'],
                          'hostSourceHead': recipe['hostSourceHead']}
        write_exclusive(root / 'owner-final-approval.json', final_approval)
        bundle['approval']['approved'] = True
        bundle['status'] = 'OWNER_APPROVED_NO_EMAIL_SESSION'
        write_exclusive(recipe['approvedBundlePath'], bundle)
        phase = 'runtime'
        remaining = (dt.datetime.fromisoformat(summary['sessionDeadline'].replace('Z', '+00:00')) - dt.datetime.now(dt.timezone.utc)).total_seconds()
        if remaining <= 360:
            raise Hold('Original session has insufficient remaining time')
        result = runner([recipe['files']['node']['path'], str(SCRIPTS / 'run-p10b-no-email-session.js'), '--execute',
                         '--bundle', recipe['approvedBundlePath'], '--evidence', recipe['evidenceDirectory'],
                         '--native-client', recipe['files']['native']['path']], environment, remaining + 60)
        closure = read_public(Path(recipe['evidenceDirectory']) / 'p10b-runtime-only-auth-closure.json')
        if result.get('success') is not True or closure.get('success') is not True or closure.get('cleanupVerified') is not True or closure.get('reapVerified') is not True or closure.get('sessionDigest') != summary['sessionDigest']:
            raise Hold('Runtime/private cleanup not proved')
        success = True
        phase = 'closed'
        return 0
    except BaseException as error:
        if isinstance(error, PublicInputHold):
            public_input_field = error.field
            public_input_error = error.code
        emit('Owner session held; preserve evidence and uncertain private directories. No retry or new token. '
             'Do not clear pending intents. Revoke only the matching new token manually after closed clients '
             'or under separately approved incident handling.')
        return 2
    finally:
        if environment is not None:
            environment.pop('FLY_API_TOKEN', None)
        console_closure_failed = False
        if console is not None:
            try:
                console.__exit__(None, None, None)
            except BaseException:
                console_closure_failed = True
                success = False
                phase = 'private-input-closure-held'
                emit('Private input closure held: PRIVATE_INPUT_CLOSURE_UNVERIFIED. No continuation.')
        if recipe is not None:
            try:
                write_exclusive(Path(recipe['outputDirectory']) / 'owner-terminal.json',
                                {'success': success, 'phase': phase, 'closedAt': utc_now(), 'productionReady': False,
                                 'globalAutomationPaused': True, 'rawErrorsRetained': False,
                                 'uncertainPrivateCleanupRetained': not success, 'automaticRevocation': False,
                                 'publicInputField': public_input_field, 'publicInputError': public_input_error,
                                 'credentialInputRequested': credential_input_requested,
                                 'authenticatedPreflightRequested': authenticated_preflight_requested})
            except Exception:
                pass  # Existing evidence is never overwritten.
        if console_closure_failed:
            return 2
        if success:
            emit('No-email runtime and private cleanup verified. Manually revoke only public token ID ' + token_id +
                 ' after confirming all clients are closed; this script does not revoke it.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--recipe', required=True, type=Path)
    parser.add_argument('--recipe-sha256', required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--check-only', action='store_true')
    modes.add_argument('--run', action='store_true')
    args = parser.parse_args()
    if args.check_only:
        try:
            _, result, _ = check_recipe(args.recipe, expected_recipe_sha256=args.recipe_sha256)
            print(json.dumps(result, indent=2))
            return 0
        except Exception:
            print('Static owner setup held. Resolve checks before creating a token.', file=sys.stderr)
            return 2
    return run_owner(args.recipe, expected_recipe_sha256=args.recipe_sha256)


if __name__ == '__main__':
    raise SystemExit(main())
