"""Bounded build operator. Never invoked on this Mac with a build command.

Only the future ephemeral Linux runner's approved job may use prepare/run/finish.
Local tests use tiny disposable fixtures and Python child processes only.
"""
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import resource
import selectors
import signal
import stat
import subprocess
import sys
import tarfile
import time

SOURCE = 'f22738d22ee33ed3f30df448fdcbebbad396d91a'
TREE = '8d436f7a7db338157d791bc64396bbfdb4cd4747'
MIB = 1024 * 1024
IMAGE_MAX = 512 * MIB
LOG_MAX = 512 * 1024
RECEIPT_MAX = 512 * 1024
CONTEXT_MAX = 20 * MIB
PINS = {
    'Dockerfile': '5b28898cb7a08fa335304643a192cd5cb3644d01d0b98b58b1f323136a439f4d',
    '.dockerignore': 'ebf2c6d4f96eab4bea6d4b3447c34d83f2eff4a04c8c78deb6bd6458ea5e5725',
    'package.json': '5770a1a831fc0730838f92effb3acc884c5c870c2e68de0b7e1771f0b93e63ae',
    'package-lock.json': 'ecb12f6dc640ad1450124897b64bbb58520ff399f8bc8306f0205a490d7825aa',
}


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(MIB), b''):
            h.update(chunk)
    return h.hexdigest()


def regular(path, maximum):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > maximum:
        raise ValueError('invalid or oversized file: ' + path.name)
    return s.st_size


def bounded_json(path, value, maximum=RECEIPT_MAX):
    data = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    if len(data) > maximum:
        raise ValueError('receipt limit exceeded')
    with open(path, 'xb') as f:
        f.write(data)


def prepare(source, work):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args], timeout=30).decode().strip()
    if git('rev-parse', 'HEAD') != SOURCE or git('rev-parse', 'HEAD^{tree}') != TREE:
        raise ValueError('source/tree drift')
    if git('status', '--porcelain', '--untracked-files=all'):
        raise ValueError('source checkout not clean')
    for name, expected in PINS.items():
        if digest(source / name) != expected:
            raise ValueError('recipe/lock drift')
    work.mkdir(mode=0o700)
    archive = work / 'source.tar'
    # File-size limit also applies while Git exports, before extraction.
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (CONTEXT_MAX, CONTEXT_MAX))
    with open(archive, 'xb') as f:
        subprocess.run(['git', '-C', str(source), 'archive', '--format=tar', SOURCE],
                       stdout=f, check=True, timeout=30, preexec_fn=limits)
    regular(archive, CONTEXT_MAX)
    context = work / 'context'
    context.mkdir(mode=0o700)
    count = total = 0
    files = {}
    with tarfile.open(archive, 'r:') as tf:
        for item in tf:
            path = PurePosixPath(item.name)
            if path.is_absolute() or '..' in path.parts or not (item.isdir() or item.isfile()):
                raise ValueError('unsafe source archive member')
            if item.isdir():
                (context / item.name).mkdir(parents=True, exist_ok=True)
                continue
            count += 1
            total += item.size
            if count > 1000 or total > CONTEXT_MAX:
                raise ValueError('source extraction cap exceeded')
            target = context / item.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, 'xb') as f, tf.extractfile(item) as src:
                while chunk := src.read(MIB):
                    f.write(chunk)
            os.chmod(target, item.mode & 0o777)
            files[item.name] = {'sha256': digest(target), 'mode': item.mode & 0o777}
    for name, expected in PINS.items():
        if digest(context / name) != expected:
            raise ValueError('exported recipe/lock drift')
    return {'source': SOURCE, 'tree': TREE, 'context_tar_sha256': digest(archive),
            'context_tar_bytes': archive.stat().st_size, 'tracked_files': count,
            'recipe_hashes': PINS, 'files': files}


def run_bounded(command, log, seconds=900, file_limit=IMAGE_MAX, log_limit=LOG_MAX,
                minimum_free=20 * 1024**3, output_path=None, monitor=None, env=None,
                stdin_data=None, new_session=True):
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
    start = time.monotonic()
    reason = None
    captured = 0
    child_env = {k: v for k, v in os.environ.items()
                 if k in ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'BUILDX_BUILDER')}
    if env is not None:
        child_env = dict(env)
    child_env['BUILDX_METADATA_PROVENANCE'] = 'max'
    child_env['BUILDX_METADATA_WARNINGS'] = 'true'
    p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
                         start_new_session=new_session, preexec_fn=limits, env=child_env)
    if stdin_data is not None:
        p.stdin.write(stdin_data)
        p.stdin.close()
    selector = selectors.DefaultSelector()
    selector.register(p.stdout, selectors.EVENT_READ)
    try:
        with open(log, 'xb') as output:
            while selector.get_map() or p.poll() is None:
                if monitor is not None:
                    monitor()
                if time.monotonic() - start >= seconds:
                    reason = 'deadline'
                v = os.statvfs(log.parent)
                if v.f_bavail * v.f_frsize < minimum_free:
                    reason = 'disk_floor'
                if output_path is not None and output_path.exists() and output_path.lstat().st_size > file_limit:
                    reason = 'output_file_limit'
                if reason:
                    break
                events = selector.select(timeout=0.1) if selector.get_map() else []
                if not selector.get_map():
                    time.sleep(0.05)
                for key, _ in events:
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    captured += len(chunk)
                    remaining = max(0, log_limit - output.tell())
                    output.write(chunk[:remaining])
                    if captured > log_limit:
                        reason = 'log_limit'
                        break
            if reason is None:
                try:
                    p.wait(timeout=max(0.01, seconds - (time.monotonic() - start)))
                except subprocess.TimeoutExpired:
                    reason = 'deadline'
    except BaseException:
        reason = reason or 'monitor_or_operation_failure'
        raise
    finally:
        # The only process group signalled is this exact newly spawned child group.
        # Killing the group also closes any inherited pipes on a failed run.
        if reason or p.poll() is None:
            try:
                if new_session:
                    os.killpg(p.pid, signal.SIGKILL)
                else:
                    p.kill()  # Independent ancestor owns this complete group.
            except ProcessLookupError:
                pass
        p.wait(timeout=5)
        selector.close()
        p.stdout.close()
    if output_path is not None:
        try:
            regular(output_path, file_limit)
        except (ValueError, OSError):
            reason = reason or 'output_file_limit'
    receipt = {'exit_code': p.returncode, 'reason': reason,
               'seconds': round(time.monotonic() - start, 3), 'log_bytes_seen': captured}
    if reason or p.returncode != 0:
        raise RuntimeError(json.dumps(receipt, sort_keys=True))
    return receipt


def inspect_oci(archive, diagnostics=None):
    regular(archive, IMAGE_MAX)
    members = {}
    with tarfile.open(archive, 'r:') as tf:
        for entry in tf:
            path = PurePosixPath(entry.name)
            if path.is_absolute() or '..' in path.parts or entry.name in members:
                raise ValueError('unsafe/duplicate OCI member')
            if entry.isdir():
                continue
            if not entry.isfile() or entry.size > IMAGE_MAX:
                raise ValueError('non-regular/oversized OCI member')
            members[entry.name] = entry
            if len(members) > 1000:
                raise ValueError('OCI entry cap')
            if entry.name.startswith('blobs/sha256/'):
                h = hashlib.sha256()
                with tf.extractfile(entry) as f:
                    for chunk in iter(lambda: f.read(MIB), b''):
                        h.update(chunk)
                if h.hexdigest() != entry.name.removeprefix('blobs/sha256/'):
                    raise ValueError('OCI blob hash mismatch')
        def read_json(name):
            item = members[name]
            if item.size > RECEIPT_MAX:
                raise ValueError('OCI metadata cap')
            return json.load(tf.extractfile(item))
        if read_json('oci-layout') != {'imageLayoutVersion': '1.0.0'}:
            raise ValueError('unexpected OCI layout')
        index = read_json('index.json')
        # Buildx OCI export wraps its result in a layout index. Follow nested indexes.
        roots = [d['digest'] for d in index.get('manifests', [])]
        if len(roots) != 1:
            raise ValueError('expected exactly one OCI export root')
        root_descriptor = index['manifests'][0]
        if root_descriptor.get('mediaType') not in (
                'application/vnd.oci.image.index.v1+json',
                'application/vnd.oci.image.manifest.v1+json'):
            raise ValueError('unsupported OCI root descriptor type')
        descriptors = list(index.get('manifests', []))
        leaves = []
        visited = set()
        while descriptors:
            if len(visited) > 20:
                raise ValueError('OCI descriptor depth/count cap')
            d = descriptors.pop()
            dg = d.get('digest', '')
            if not dg.startswith('sha256:') or len(dg) != 71 or dg in visited:
                raise ValueError('invalid/repeated OCI descriptor')
            visited.add(dg)
            name = 'blobs/sha256/' + dg[7:]
            if members[name].size != d['size']:
                raise ValueError('OCI descriptor size mismatch')
            value = read_json(name)
            if 'manifests' in value:
                descriptors.extend(value['manifests'])
            else:
                leaves.append((dg, value))
        platforms = []
        attestations = []
        for dg, manifest in leaves:
            c = manifest['config']
            for desc in [c, *manifest['layers']]:
                dd = desc.get('digest', '')
                if not dd.startswith('sha256:') or len(dd) != 71:
                    raise ValueError('invalid OCI config/layer digest')
                if members['blobs/sha256/' + dd[7:]].size != desc['size']:
                    raise ValueError('OCI config/layer size mismatch')
            config = read_json('blobs/sha256/' + c['digest'][7:])
            if config.get('os') == 'linux' and config.get('architecture') == 'amd64':
                platforms.append((dg, c['digest'], config))
            elif config.get('os') == 'unknown' and config.get('architecture') == 'unknown':
                for layer in manifest['layers']:
                    if layer.get('mediaType') != 'application/vnd.in-toto+json':
                        raise ValueError('unexpected non-runtime OCI manifest')
                    attestations.append(read_json('blobs/sha256/' + layer['digest'][7:]))
            else:
                raise ValueError('unexpected runtime platform')
        if len(platforms) != 1:
            raise ValueError('expected exactly one linux/amd64 image')
        dg, config_digest, config = platforms[0]
        labels = config.get('config', {}).get('Labels', {})
        if labels.get('org.opencontainers.image.revision') != SOURCE or labels.get('org.opencontainers.image.source') != 'https://github.com/muckele/uckele-group':
            raise ValueError('image source label mismatch')
        matched = [a['predicate'] for a in attestations
                   if a.get('predicateType', '').startswith('https://slsa.dev/provenance/') and
                   any(s.get('digest', {}).get('sha256') == dg[7:] for s in a.get('subject', []))]
        if diagnostics is not None:
            diagnostics.update(
                root_descriptor={k:root_descriptor[k] for k in ('digest','size','mediaType')},
                platform_manifest_digest=dg,config_digest=config_digest,
                attestation_count=len(attestations),matching_provenance_count=len(matched),
                attestations=[{
                    'predicate_type':a.get('predicateType') if a.get('predicateType') in
                        ('https://slsa.dev/provenance/v0.2','https://slsa.dev/provenance/v1') else 'unsupported',
                    'subject_sha256':[s.get('digest',{}).get('sha256') if re.fullmatch(
                        '[0-9a-f]{64}',str(s.get('digest',{}).get('sha256'))) else 'invalid'
                        for s in a.get('subject',[])[:8]],
                    'subject_count':len(a.get('subject',[]))} for a in attestations[:8]])
        if len(matched) != 1:
            raise ValueError('image-bound provenance cardinality: expected1, found'+str(len(matched)))
    return {'archive_sha256': digest(archive), 'archive_bytes': archive.stat().st_size,
            'platform': 'linux/amd64', 'platform_manifest_digest': dg,
            'config_digest': config_digest, 'result_root_digests': roots,
            'result_root_descriptor':{k:root_descriptor[k] for k in ('digest','size','mediaType')},
            'config_digest_source':'verified OCI root -> platform manifest -> config descriptor chain',
            'provenance_predicate': matched[0], 'image_config': config}


def validate_binding(image, metadata, source, context):
    if source.get('source') != SOURCE or source.get('tree') != TREE or source.get('recipe_hashes') != PINS:
        raise ValueError('source receipt mismatch')
    actual_files = {str(p.relative_to(context)) for p in context.rglob('*') if not p.is_dir()}
    if actual_files != set(source['files']):
        raise ValueError('context graph drift')
    for name, expected in source['files'].items():
        p = context / name
        regular(p, CONTEXT_MAX)
        if digest(p) != expected['sha256'] or stat.S_IMODE(p.stat().st_mode) != expected['mode']:
            raise ValueError('context bytes/mode drift')
    result = metadata.get('containerimage.digest')
    descriptor=metadata.get('containerimage.descriptor',{})
    root=image['result_root_descriptor']
    if image['result_root_digests'] != [result] or not isinstance(descriptor,dict) or \
       any(descriptor.get(k)!=root[k] for k in ('digest','size','mediaType')):
        raise ValueError('build result/archive root mismatch')
    # BuildKit's attested index branch has no single top-level config annotation.
    # The verified result root cryptographically binds its sole runnable image's
    # config. Never substitute the index digest for the config digest.
    if 'containerimage.config.digest' in metadata:
        if metadata['containerimage.config.digest'] != image['config_digest']:
            raise ValueError('build config/archive mismatch')
    elif root['mediaType'] != 'application/vnd.oci.image.index.v1+json':
        raise ValueError('build config/archive mismatch')
    provenance = metadata.get('buildx.build.provenance', {})
    if provenance != image['provenance_predicate']:
        raise ValueError('metadata/image provenance mismatch')
    if provenance.get('buildType') != 'https://mobyproject.org/buildkit@v1':
        raise ValueError('missing BuildKit provenance')
    materials = provenance.get('materials', [])
    node = [m for m in materials if re.match(r'^pkg:docker/(?:library/)?node@22-bookworm-slim(?:\?|$)', m.get('uri', ''))]
    if not node or any(not re.fullmatch(r'[0-9a-f]{64}', m.get('digest', {}).get('sha256', '')) for m in node):
        raise ValueError('missing resolved node base material')
    allowed = {'VITE_PUBLIC_SITE_URL':'https://www.uckelegroup.com',
               'VITE_PUBLIC_CONTACT_EMAIL':'mathew@uckelegroup.com',
               'VITE_PUBLIC_CONTACT_PHONE':'914.361.9153',
               'VITE_PUBLIC_LINKEDIN_URL':'https://www.linkedin.com/in/mathew-uckele',
               'VITE_TURNSTILE_SITE_KEY':''}
    params = provenance.get('invocation', {}).get('parameters', {}).get('args', {})
    if not isinstance(params, dict):
        raise ValueError('unsupported provenance argument schema')
    for key, value in params.items():
        if key.startswith('build-arg:') and (key[10:] not in allowed or value != allowed[key[10:]]):
            raise ValueError('unapproved build argument')


def upload_gate(out):
    allowed = {'candidate.oci.tar': IMAGE_MAX, 'receipt.json': RECEIPT_MAX,
               'build.log': LOG_MAX}
    if {p.name for p in out.iterdir()} != set(allowed):
        raise ValueError('unexpected/missing publication file')
    total = sum(regular(out / name, limit) for name, limit in allowed.items())
    if total > IMAGE_MAX + RECEIPT_MAX + LOG_MAX:
        raise ValueError('aggregate upload cap')
    return total


if __name__ == '__main__':
    action, *args = sys.argv[1:]
    if action == 'prepare':
        result = prepare(Path(args[0]), Path(args[1]))
        bounded_json(Path(args[1]) / 'source-binding.json', result)
    elif action == 'run':
        result = run_bounded(args[1:], Path(args[0]), output_path=Path(args[0]).parent / 'candidate.oci.tar')
        print(json.dumps(result))
    elif action == 'finish':
        out, work = map(Path, args)
        regular(work / 'build-metadata.json', RECEIPT_MAX)
        regular(work / 'source-binding.json', RECEIPT_MAX)
        regular(work / 'tools.json', RECEIPT_MAX)
        metadata = json.loads((work / 'build-metadata.json').read_bytes())
        source = json.loads((work / 'source-binding.json').read_bytes())
        image = inspect_oci(out / 'candidate.oci.tar')
        validate_binding(image, metadata, source, work / 'context')
        receipt = {'source_binding': source, 'image': image, 'build_metadata': metadata,
                   'run_id': os.environ['GITHUB_RUN_ID'], 'run_attempt': os.environ['GITHUB_RUN_ATTEMPT'],
                   'operator_sha': os.environ['GITHUB_SHA'], 'tools': json.loads((work / 'tools.json').read_bytes()),
                   'scope': 'build only; image boot/native/entrypoint validation still pending'}
        bounded_json(out / 'receipt.json', receipt)
        print(json.dumps({'upload_bytes': upload_gate(out), 'image': image}))
    elif action == 'upload-gate':
        print(upload_gate(Path(args[0])))
    else:
        raise SystemExit('unknown operation')
