import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import guard


def fixture(path, arch='amd64', corrupt=False, missing_layer=False, nested=True,
            named=True, predicate=None, predicate_type='https://slsa.dev/provenance/v0.2',
            subject_digest=None, attestation_copies=1, extra_root=False):
    blobs = {}
    def blob(value, media):
        data = json.dumps(value, sort_keys=True).encode()
        dg = hashlib.sha256(data).hexdigest()
        blobs['blobs/sha256/' + dg] = data
        return {'digest': 'sha256:' + dg, 'size': len(data), 'mediaType': media}
    config = blob({'os': 'linux', 'architecture': arch,
                   'config': {'Labels': {'org.opencontainers.image.revision': guard.SOURCE,
                   'org.opencontainers.image.source':'https://github.com/muckele/uckele-group'}}},
                   'application/vnd.oci.image.config.v1+json')
    layer = blob({'synthetic': True}, 'application/vnd.oci.image.layer.v1.tar')
    manifest = blob({'schemaVersion': 2, 'config': config, 'layers': [layer]}, 'application/vnd.oci.image.manifest.v1+json')
    attestation = blob({'predicateType':predicate_type,
                        'predicate':predicate if predicate is not None else {'fixture':'synthetic'},
                        'subject':[{'digest':{'sha256':subject_digest or manifest['digest'][7:]}}] if named else []}, 'application/vnd.in-toto+json')
    attest_config = blob({'os':'unknown','architecture':'unknown'}, 'application/vnd.oci.image.config.v1+json')
    attest_manifest = blob({'schemaVersion':2,'config':attest_config,'layers':[attestation]*attestation_copies}, 'application/vnd.oci.image.manifest.v1+json')
    if nested:
        manifest = blob({'schemaVersion': 2, 'manifests': [manifest,attest_manifest]}, 'application/vnd.oci.image.index.v1+json')
    blobs['index.json'] = json.dumps({'schemaVersion': 2, 'manifests': [manifest]+([attest_manifest] if extra_root else [])}).encode()
    blobs['oci-layout'] = b'{"imageLayoutVersion":"1.0.0"}'
    if corrupt:
        blobs['blobs/sha256/' + config['digest'][7:]] = b'X' * config['size']
    if missing_layer:
        del blobs['blobs/sha256/' + layer['digest'][7:]]
    with tarfile.open(path, 'w') as tf:
        for name, data in blobs.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ug-build-fixture-', dir='/tmp')
        self.addCleanup(self.tmp.cleanup)
        self.p = Path(self.tmp.name)

    def test_valid_nested_oci_platform_and_hash(self):
        fixture(self.p / 'image')
        r = guard.inspect_oci(self.p / 'image')
        self.assertEqual(r['platform'], 'linux/amd64')
        self.assertEqual(r['archive_sha256'], guard.digest(self.p / 'image'))

    def test_unnamed_export_has_no_subject_and_returns_bounded_structure(self):
        # Version-pinned BuildKit writer.go/make.go: empty image name gives no
        # default subjects. No live archive is available from run40568987891.
        fixture(self.p/'image',named=False)
        diagnostic={}
        with self.assertRaisesRegex(ValueError,'cardinality: expected1, found0'):
            guard.inspect_oci(self.p/'image',diagnostics=diagnostic)
        self.assertEqual(diagnostic['matching_provenance_count'],0)
        self.assertEqual(diagnostic['attestations'][0]['subject_sha256'],[])
        self.assertLess(len(json.dumps(diagnostic).encode()),16384)

    def test_wrong_subject_duplicate_provenance_and_extra_roots_fail_closed(self):
        for options,error in [({'subject_digest':'0'*64},'found0'),
                ({'attestation_copies':2},'found2'),({'extra_root':True},'exactly one OCI export root')]:
            with self.subTest(options=options):
                fixture(self.p/'image',**options)
                with self.assertRaisesRegex(ValueError,error):guard.inspect_oci(self.p/'image')

    def test_wrong_platform_fails(self):
        fixture(self.p / 'image', arch='arm64')
        with self.assertRaises(ValueError): guard.inspect_oci(self.p / 'image')

    def test_tampered_blob_fails(self):
        fixture(self.p / 'image', corrupt=True)
        with self.assertRaisesRegex(ValueError, 'hash mismatch'): guard.inspect_oci(self.p / 'image')

    def test_missing_layer_fails(self):
        fixture(self.p / 'image', missing_layer=True)
        with self.assertRaises(KeyError): guard.inspect_oci(self.p / 'image')

    def test_truncated_blob_fails(self):
        fixture(self.p / 'image')
        with open(self.p / 'image', 'r+b') as f: f.truncate(600)
        with self.assertRaises((ValueError, tarfile.TarError)): guard.inspect_oci(self.p / 'image')

    def test_symlink_archive_fails(self):
        fixture(self.p / 'image')
        (self.p / 'link').symlink_to(self.p / 'image')
        with self.assertRaises(ValueError): guard.inspect_oci(self.p / 'link')

    def test_oversized_archive_fails_without_reading_sparse_body(self):
        with open(self.p / 'image', 'wb') as f: f.truncate(guard.IMAGE_MAX + 1)
        with self.assertRaises(ValueError): guard.inspect_oci(self.p / 'image')

    def test_upload_exact_allowlist_and_aggregate(self):
        for n in ('candidate.oci.tar', 'receipt.json', 'build.log'): (self.p / n).write_bytes(b'x')
        self.assertEqual(guard.upload_gate(self.p), 3)
        (self.p / 'unrelated').write_bytes(b'x')
        with self.assertRaises(ValueError): guard.upload_gate(self.p)

    def test_upload_symlink_fails(self):
        (self.p / 'candidate.oci.tar').symlink_to('/dev/null')
        for n in ('receipt.json', 'build.log'): (self.p / n).write_bytes(b'x')
        with self.assertRaises(ValueError): guard.upload_gate(self.p)

    def test_oversized_receipt_fails_before_write(self):
        with self.assertRaises(ValueError): guard.bounded_json(self.p / 'receipt', {'x': 'a' * 100}, maximum=50)
        self.assertFalse((self.p / 'receipt').exists())

    def test_source_drift_fails_before_export(self):
        with patch('guard.subprocess.check_output', return_value=b'wrong\n'):
            with self.assertRaisesRegex(ValueError, 'source/tree drift'): guard.prepare(self.p, self.p / 'work')

    def test_prepare_preserves_git_executable_mode(self):
        (self.p/'script.sh').write_bytes(b'#!/bin/sh\ntrue\n')
        expected=guard.digest(self.p/'script.sh')
        def export(*args, **kwargs):
            with tarfile.open(fileobj=kwargs['stdout'],mode='w') as tf:
                data=(self.p/'script.sh').read_bytes()
                entry=tarfile.TarInfo('script.sh');entry.mode=0o755;entry.size=len(data)
                tf.addfile(entry,io.BytesIO(data))
        with patch('guard.PINS',{'script.sh':expected}), patch('guard.subprocess.check_output',side_effect=[(guard.SOURCE+'\n').encode(),(guard.TREE+'\n').encode(),b'']), patch('guard.subprocess.run',side_effect=export):
            result=guard.prepare(self.p,self.p/'work')
        self.assertEqual(result['files']['script.sh']['mode'],0o755)
        self.assertEqual((self.p/'work/context/script.sh').stat().st_mode&0o777,0o755)

    def test_run_success(self):
        r = guard.run_bounded([sys.executable, '-c', 'print("fixture")'], self.p / 'log', seconds=2, minimum_free=0)
        self.assertEqual(r['exit_code'], 0)

    def test_run_error_keeps_bounded_reason(self):
        with self.assertRaisesRegex(RuntimeError, '"exit_code": 7'):
            guard.run_bounded([sys.executable, '-c', 'raise SystemExit(7)'], self.p / 'log', seconds=2, minimum_free=0)

    def test_deadline_stops_exact_child(self):
        with self.assertRaisesRegex(RuntimeError, 'deadline'):
            guard.run_bounded([sys.executable, '-c', 'import time; time.sleep(3)'], self.p / 'log', seconds=.1, minimum_free=0)

    def test_closed_stdout_still_enforces_exit_deadline(self):
        with self.assertRaisesRegex(RuntimeError, 'deadline'):
            guard.run_bounded([sys.executable, '-c', 'import os,time; os.close(1); os.close(2); time.sleep(3)'], self.p / 'log', seconds=.1, minimum_free=0)

    def test_output_cap_stops_and_bounds_log(self):
        with self.assertRaisesRegex(RuntimeError, 'log_limit'):
            guard.run_bounded([sys.executable, '-c', 'print("x"*10000)'], self.p / 'log', seconds=2, log_limit=100, minimum_free=0)
        self.assertLessEqual((self.p / 'log').stat().st_size, 100)

    def test_file_limit_rejects_oversized_output(self):
        target = str(self.p / 'limited')
        with self.assertRaises(RuntimeError):
            guard.run_bounded([sys.executable, '-c', 'import sys\nwith open(sys.argv[1],"wb") as f: f.write(b"x"*4096)', target], self.p / 'log', seconds=2, file_limit=1024, minimum_free=0, output_path=self.p/'limited')
        self.assertLessEqual((self.p/'limited').stat().st_size,1024)

    def binding_fixture(self):
        (self.p/'source-file').write_bytes(b'fixture')
        os.chmod(self.p/'source-file', 0o755)
        source={'source':guard.SOURCE,'tree':guard.TREE,'recipe_hashes':guard.PINS,
                'files':{'source-file':{'sha256':guard.digest(self.p/'source-file'),'mode':0o755}}}
        provenance={'buildType':'https://mobyproject.org/buildkit@v1',
                    'materials':[{'uri':'pkg:docker/node@22-bookworm-slim?platform=linux%2Famd64','digest':{'sha256':'c'*64}}],
                    'invocation':{'parameters':{'args':{}}}}
        fixture(self.p/'image',predicate=provenance)
        image=guard.inspect_oci(self.p/'image');(self.p/'image').unlink()
        metadata={'containerimage.digest':image['result_root_digests'][0],
                  'containerimage.descriptor':image['result_root_descriptor'],
                  'containerimage.config.digest':image['config_digest'],
                  'buildx.build.provenance':provenance}
        return image,metadata,source

    def test_valid_source_and_build_binding(self):
        guard.validate_binding(*self.binding_fixture(),self.p)

    def test_index_export_binds_config_via_verified_root_without_optional_metadata_key(self):
        image,metadata,source=self.binding_fixture()
        del metadata['containerimage.config.digest']
        guard.validate_binding(image,metadata,source,self.p)

    def test_present_config_digest_and_root_descriptor_must_match(self):
        image,metadata,source=self.binding_fixture()
        for key,value in [('containerimage.config.digest','sha256:'+'d'*64),
                ('containerimage.config.digest',None),
                ('containerimage.descriptor',dict(metadata['containerimage.descriptor'],size=1)),
                ('containerimage.descriptor',dict(metadata['containerimage.descriptor'],mediaType='unknown'))]:
            changed=dict(metadata,**{key:value})
            with self.subTest(key=key,value=value):
                with self.assertRaises(ValueError):guard.validate_binding(image,changed,source,self.p)

    def test_reduced_metadata_cannot_replace_full_image_provenance(self):
        image,metadata,source=self.binding_fixture()
        image['provenance_predicate']['buildConfig']={'llbDefinition':[{'id':'step0'}]}
        metadata['buildx.build.provenance']=dict(metadata['buildx.build.provenance'],buildConfig=None)
        with self.assertRaisesRegex(ValueError,'provenance mismatch'):
            guard.validate_binding(image,metadata,source,self.p)

    def test_mismatched_result_digest_fails(self):
        i,m,s=self.binding_fixture(); m['containerimage.digest']='sha256:'+'d'*64
        with self.assertRaisesRegex(ValueError,'root mismatch'): guard.validate_binding(i,m,s,self.p)

    def test_missing_resolved_base_material_fails(self):
        i,m,s=self.binding_fixture(); m['buildx.build.provenance']['materials']=[]
        i['provenance_predicate']=m['buildx.build.provenance']
        with self.assertRaisesRegex(ValueError,'base material'): guard.validate_binding(i,m,s,self.p)

    def test_unapproved_build_arg_fails(self):
        i,m,s=self.binding_fixture(); m['buildx.build.provenance']['invocation']['parameters']['args']={'build-arg:SECRET':'bad'}
        i['provenance_predicate']=m['buildx.build.provenance']
        with self.assertRaisesRegex(ValueError,'build argument'): guard.validate_binding(i,m,s,self.p)

    def test_changed_source_bytes_fails(self):
        i,m,s=self.binding_fixture(); (self.p/'source-file').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'bytes/mode drift'): guard.validate_binding(i,m,s,self.p)

    def test_changed_source_mode_fails(self):
        i,m,s=self.binding_fixture(); os.chmod(self.p/'source-file',0o644)
        with self.assertRaisesRegex(ValueError,'bytes/mode drift'): guard.validate_binding(i,m,s,self.p)

    def test_metadata_and_image_predicate_mismatch_fails(self):
        i,m,s=self.binding_fixture(); i['provenance_predicate']['buildType']='other'
        with self.assertRaisesRegex(ValueError,'provenance mismatch'): guard.validate_binding(i,m,s,self.p)

    def test_disk_admission_monitor_stops(self):
        with self.assertRaisesRegex(RuntimeError, 'disk_floor'):
            guard.run_bounded([sys.executable, '-c', 'import time; time.sleep(3)'], self.p / 'log', seconds=2, minimum_free=10**30)


if __name__ == '__main__':
    unittest.main(verbosity=2)
