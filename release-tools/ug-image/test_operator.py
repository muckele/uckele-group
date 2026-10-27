"""Small offline guard fixtures only. Never invokes Docker, Skopeo or GitHub."""
import json
from pathlib import Path
import tempfile
import unittest
import importlib.util
import subprocess
from unittest.mock import patch

import operator_once as op


class OperatorPolicyTests(unittest.TestCase):
    def test_mocked_end_to_end_build_import_smoke_and_removal(self):
        nonce='a'*32;bid='b'*64;sid='c'*64;image_id='sha256:'+'d'*64
        config={'Entrypoint':['docker-entrypoint.sh'],'Cmd':['node','server/index.js'],
                'WorkingDir':'/app','Env':['PATH=/usr/bin:/bin','NODE_VERSION=22.23.3',
                    'YARN_VERSION=1.22.22','NODE_ENV=production'],'Volumes':None,'User':''}
        image={'config_digest':image_id,'image_config':{'rootfs':{'diff_ids':['sha256:'+'e'*64]}},
               'archive_sha256':'a'*64,'provenance_predicate':{},'result_root_digests':['sha256:'+'f'*64]}
        builder={'Id':bid,'Image':'sha256:'+'b'*64,'Config':{'Env':['UG_IMAGE_OWNER='+nonce]},
            'HostConfig':{'Memory':4*op.GIB,'MemorySwap':4*op.GIB,'CpuPeriod':100000,
               'CpuQuota':200000,'Privileged':True,'CgroupnsMode':'private',
               'RestartPolicy':{'Name':'no'},'NetworkMode':'bridge'},'State':{'Running':True}}
        calls=[];created={};stopped=False
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            root=Path(tmp)
            class Commands:
                def __init__(self,*a,**kw):self.monitor=None
                def __call__(self,args,seconds=10,**kw):
                    nonlocal stopped
                    calls.append(args)
                    if args[:3]==['docker','buildx','build']:
                        (root/'metadata.json').write_text('{}');(root/'candidate.oci.tar').write_text('synthetic')
                    if args[:3]==['docker','image','ls']:return b''
                    if args[:3]==['docker','image','inspect']:
                        return json.dumps([{'Id':image_id,'RootFS':{'Layers':['sha256:'+'e'*64]},'Config':config}]).encode()
                    if args[:2]==['docker','create']:
                        env=[args[i+1] for i,x in enumerate(args[:-1]) if x=='--env']
                        created.update(Id=sid,Image=image_id,Config=dict(config,Env=env+config['Env'][:-1]),
                          HostConfig={'Privileged':False,'NetworkMode':'none','ReadonlyRootfs':True,
                            'Memory':512*op.guard.MIB,'MemorySwap':512*op.guard.MIB,'NanoCpus':2000000000,
                            'ShmSize':op.guard.MIB,'Tmpfs':{'/tmp':'rw,nosuid,nodev,noexec,size=240m'},
                            'PortBindings':{},'Binds':None,'Devices':[],'PidMode':'','IpcMode':'private',
                            'PidsLimit':128,'RestartPolicy':{'Name':'no'},'CapDrop':['ALL'],
                            'SecurityOpt':['no-new-privileges'],
                            'LogConfig':{'Type':'local','Config':{'max-size':'512k','max-file':'1'}}},Mounts=[])
                    if args[:2]==['docker','inspect']:
                        if args[-1]=='buildx_buildkit_ug-image-1':return json.dumps([builder]).encode()
                        if args[-1]==sid:return json.dumps([{'State':{'Running':not stopped,'ExitCode':0,'OOMKilled':False}}]).encode()
                        return json.dumps([created]).encode()
                    if args[:2]==['docker','logs']:
                        return b'Uckele Group backend listening on 127.0.0.1:8787\n[server] SIGTERM received; stopping schedulers and HTTP server'
                    if args[:2]==['docker','stop'] and args[-1]==sid:stopped=True
                    if args[:3]==['docker','exec',bid]:
                        if 'free_kib' in args[-1]:return b'{"free_kib":100000000}'
                        return json.dumps({'self_cgroup':'0::/init','memory_max':str(4*op.GIB),
                              'swap_max':'0','cpu_max':'200000 100000','mount_root':'/'}).encode()
                    if args[:2]==['docker','exec']:return b'{"GETs":[1,2,3,4]}'
                    return b''
            def prepare(*args):
                (root/'work/context').mkdir(parents=True)
                return {'context_tar_sha256':'1'*64,'context_tar_bytes':100,'tracked_files':506,'recipe_hashes':op.guard.PINS}
            def sample(*a,**kw):op.SMOKE_SAMPLES[sid]={'samples':1,'peak_bytes':100};return op.SMOKE_SAMPLES[sid]
            with patch('operator_once.FixedCommands',Commands),patch('operator_once.get_public_repository'), \
                 patch('operator_once.guard.prepare',side_effect=prepare), \
                 patch('operator_once.guard.inspect_oci',return_value=image), \
                 patch('operator_once.guard.validate_binding'),patch('operator_once.sample_smoke',side_effect=sample), \
                 patch('operator_once.inspect_container',return_value=None):
                result=op.workload(root,Path('/synthetic/source'),op.time.monotonic(),'1',nonce)
            self.assertEqual(result['graceful_exit_code'],0)
            self.assertIn(['docker','rm',sid],calls)
            self.assertTrue((root/'local-image-intent.json').exists())
            self.assertEqual(result['smoke']['GETs'],[1,2,3,4])
            build=[args for args in calls if args[:3]==['docker','buildx','build']][0]
            self.assertEqual(build[build.index('--tag')+1],'ug-ui-qualification:1')
            self.assertIn('--provenance=mode=max,version=v0.2',build)
    def test_shared_deadline_reserves_cleanup(self):
        with patch('operator_once.time.monotonic', return_value=1150):
            with self.assertRaisesRegex(RuntimeError, 'cleanup reserve'):
                op.remaining(0, 60)

    def test_independent_smoke_deadline_survives_stalled_workload(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            root=Path(tmp)
            (root/'smoke-lease.json').write_text(json.dumps({'name':'ug-smoke-1','owner':'owned','start':10}))
            op.enforce_smoke_lease(root,'1','owned',99)
            with self.assertRaisesRegex(RuntimeError,'smoke cleanup reserve'):
                op.enforce_smoke_lease(root,'1','owned',100)
            with self.assertRaisesRegex(RuntimeError,'identity'):
                op.enforce_smoke_lease(root,'1','other',11)

    def test_private_public_and_missing_visibility(self):
        base={'name':'ug-ui-verification','package_type':'container',
              'visibility':'private','repository':{'id':1196769573},
              'owner':{'login':'muckele'}}
        op.private_package(base)
        for bad in [dict(base,visibility='public'),dict(base,visibility=None),
                    dict(base,repository={'id':1}),dict(base,name='other')]:
            with self.assertRaises(ValueError): op.private_package(bad)

    def test_build_environment_excludes_tokens_and_host_preloads(self):
        with patch.dict('operator_once.os.environ',{'GH_TOKEN':'secret',
                'RETENTION_TOKEN':'secret','NODE_OPTIONS':'preload','PATH':'/usr/bin',
                'DOCKER_HOST':'unix:///var/run/docker.sock'},clear=True):
            env=op.child_environment(Path('/tmp/owned'))
        self.assertNotIn('GH_TOKEN',env)
        self.assertNotIn('RETENTION_TOKEN',env)
        self.assertNotIn('NODE_OPTIONS',env)
        self.assertEqual(env['HOME'],'/tmp/owned/home')
        self.assertEqual(env['BUILDX_METADATA_PROVENANCE'],'max')

    def test_builder_actual_limits_and_namespace_required(self):
        b={'Config':{'Env':['UG_IMAGE_OWNER=owned']},'HostConfig':{
            'Memory':4*op.GIB,'MemorySwap':4*op.GIB,'CpuPeriod':100000,
            'CpuQuota':200000,'Privileged':True,'CgroupnsMode':'private',
            'RestartPolicy':{'Name':'no'},'NetworkMode':'bridge'},
            'State':{'Running':True},'Mounts':[]}
        op.validate_builder(b,'owned')
        for key,value in [('MemorySwap',-1),('CpuQuota',0),('CgroupnsMode','host')]:
            changed=json.loads(json.dumps(b));changed['HostConfig'][key]=value
            with self.assertRaises(ValueError):op.validate_builder(changed,'owned')
        changed=json.loads(json.dumps(b));changed['Config']['Env']=[]
        with self.assertRaises(ValueError):op.validate_builder(changed,'owned')

    def test_cgroup_kernel_values_and_mount_root_must_match(self):
        good={'self_cgroup':'0::/','memory_max':str(4*op.GIB),
              'swap_max':'0','cpu_max':'200000 100000','mount_root':'/'}
        op.validate_cgroup(good)
        for key,value in [('self_cgroup','0::/host/sibling'),('memory_max','max'),
                          ('swap_max','max'),('cpu_max','max 100000'),
                          ('mount_root','/host')]:
            with self.assertRaises(ValueError):op.validate_cgroup(dict(good,**{key:value}))

    def test_cgroup_captured_buildkit_init_layout_keeps_enclosing_limits(self):
        # Exact non-sensitive payload from failed run40567282005 attempt1.
        captured={'cpu_max':'200000 100000','memory_max':'4294967296',
                  'mount_root':'/','self_cgroup':'0::/init','swap_max':'0'}
        try:
            op.validate_cgroup(captured)
        except ValueError as error:
            self.fail('documented BuildKit init child under bounded root rejected: '+str(error))

    def test_cgroup_membership_rejects_unknown_escape_and_malformed_paths(self):
        good={'self_cgroup':'0::/init','memory_max':str(4*op.GIB),
              'swap_max':'0','cpu_max':'200000 100000','mount_root':'/'}
        for membership in ('0::/host/sibling','0::/../host','0::/init/../',
                '0::/init/worker','0::/init/','0:://init','0::/INIT',
                '0::/init\n0::/','1:memory:/init','/init','',None,0):
            with self.subTest(membership=membership):
                with self.assertRaises(ValueError):
                    op.validate_cgroup(dict(good,self_cgroup=membership))

    def test_cgroup_both_layouts_reject_missing_extra_and_altered_root_limits(self):
        for membership in ('0::/','0::/init'):
            good={'self_cgroup':membership,'memory_max':str(4*op.GIB),
                  'swap_max':'0','cpu_max':'200000 100000','mount_root':'/'}
            for key in good:
                missing=dict(good);del missing[key]
                with self.subTest(membership=membership,missing=key):
                    with self.assertRaises(ValueError):op.validate_cgroup(missing)
            for key,value in [('memory_max','max'),('memory_max',str(8*op.GIB)),
                    ('memory_max',4*op.GIB),('memory_max',''),('memory_max',None),
                    ('swap_max','max'),('swap_max','1'),('cpu_max','max 100000'),
                    ('cpu_max','300000 100000'),('cpu_max','200000 200000'),
                    ('mount_root','/host'),('mount_root','/init'),('extra','unknown')]:
                with self.subTest(membership=membership,key=key,value=value):
                    with self.assertRaises(ValueError):op.validate_cgroup(dict(good,**{key:value}))

    def test_smoke_preserves_node_entrypoint_and_rejects_unknown_image_env(self):
        config={'Entrypoint':['docker-entrypoint.sh'],'Cmd':['node','server/index.js'],
                'WorkingDir':'/app','Env':['NODE_ENV=production','PATH=/usr/local/bin:/usr/bin:/bin',
                'NODE_VERSION=22.23.3','YARN_VERSION=1.22.22'],'Volumes':None,'User':''}
        op.validate_image_config(config)
        for field,value in [('Entrypoint',[]),('Cmd',['node','other.js']),
                            ('Env',config['Env']+['DATABASE_URL=secret']),('Volumes',{'/data':{}})]:
            with self.assertRaises(ValueError):op.validate_image_config(dict(config,**{field:value}))

    def test_smoke_flags_no_real_mount_no_ports_and_exact_caps(self):
        args=op.smoke_create('owned','image','nonce')
        text=' '.join(args)
        self.assertIn('--network none',text)
        self.assertIn('--read-only',text)
        self.assertIn('--memory 512m --memory-swap 512m',text)
        self.assertIn('--cpus 2',text)
        self.assertNotIn('--privileged',args)
        self.assertNotIn('--publish',args)
        self.assertNotIn('--volume',args)
        self.assertEqual(args[-1],'image')
        for name in ['FOLLOW_UP_EMAIL_ENABLED','FOLLOW_UP_AI_ENABLED',
                     'DEAL_HUNTER_CIM_PROVIDER_ENABLED','BACKUP_ENABLED']:
            self.assertIn(name+'=false',args)

    def test_cleanup_never_signals_foreign_container(self):
        foreign={'Id':'abc','Config':{'Env':['UG_IMAGE_OWNER=other']},
                 'State':{'Running':True}}
        calls=[]
        def run(args,*a,**kw):
            calls.append(args)
            if args[:2]==['docker','inspect']:return json.dumps([foreign]).encode()
            raise AssertionError('foreign object mutation')
        result=op.cleanup_objects('1','owned',run)
        self.assertFalse(result['verified'])
        self.assertFalse(any('stop' in a or 'rm' in a for a in calls))

    def test_missing_package_is_not_an_upload_permission(self):
        self.assertFalse(op.retention_eligible(None))
        self.assertFalse(op.retention_eligible({'visibility':'public'}))

    def test_cleanup_uses_exact_verified_id_and_mount_binding(self):
        nonce='a'*32;identity='b'*64
        name='buildx_buildkit_ug-image-1';present=True;calls=[]
        def run(args,*a,**kw):
            nonlocal present
            calls.append(args)
            if args[:2]==['docker','inspect']:
                if args[-1]!=name or not present:
                    raise subprocess.CalledProcessError(1,args,stderr=('Error: No such object: '+args[-1]+'\n').encode())
                return json.dumps([{'Id':identity,'Name':'/'+name,
                     'Config':{'Env':['UG_IMAGE_OWNER='+nonce]},'State':{'Running':False},
                     'Mounts':[{'Type':'volume','Name':name+'_state'}]}]).encode()
            if args[:2]==['docker','rm']:self.assertEqual(args[-1],identity);present=False
            return b''
        result=op.cleanup_objects('1',nonce,run)
        self.assertTrue(result['verified'])
        self.assertIn(['docker','volume','rm',name+'_state'],calls)

    def test_orphan_volume_kept_without_owner_container(self):
        calls=[]
        def run(args,*a,**kw):
            calls.append(args)
            if args[:2]==['docker','inspect']:
                raise subprocess.CalledProcessError(1,args,stderr=('No such object: '+args[-1]).encode())
            return b'buildx_buildkit_ug-image-1_state\n'
        result=op.cleanup_objects('1','a'*32,run)
        self.assertFalse(result['verified'])
        self.assertFalse(any(x[:3]==['docker','volume','rm'] for x in calls))

    def test_owned_volume_timeout_is_reconciled_only_by_fresh_exact_absence(self):
        nonce='a'*32;identity='b'*64;name='buildx_buildkit_ug-image-1'
        for outcome in ('absent','present','unreadable'):
            present=True;delete_count=0
            def run(args,*a,**kw):
                nonlocal present,delete_count
                if args[:2]==['docker','inspect']:
                    if args[-1]!=name or not present:
                        raise subprocess.CalledProcessError(1,args,stderr=('No such object: '+args[-1]).encode())
                    return json.dumps([{'Id':identity,'Name':'/'+name,
                        'Config':{'Env':['UG_IMAGE_OWNER='+nonce]},'State':{'Running':False},
                        'Mounts':[{'Type':'volume','Name':name+'_state'}]}]).encode()
                if args[:2]==['docker','rm']:present=False;return b''
                if args[:3]==['docker','volume','rm']:
                    delete_count+=1;raise subprocess.TimeoutExpired(args,3)
                if args[:3]==['docker','volume','ls']:
                    self.assertEqual(args[-1],'name=^'+name+'_state$')
                    if outcome=='unreadable':raise PermissionError('fixture denied')
                    return b'' if outcome=='absent' else (name+'_state\n').encode()
                raise AssertionError(args)
            with self.subTest(outcome=outcome):
                result=op.cleanup_objects('1',nonce,run)
                self.assertEqual(delete_count,1)
                self.assertEqual(result['verified'],outcome=='absent')
                self.assertTrue(result['builder_container_absence_verified'])

    def test_unknown_inspect_failure_is_not_absence(self):
        def run(args):raise subprocess.CalledProcessError(1,args,stderr=b'permission denied')
        with self.assertRaises(subprocess.CalledProcessError):op.inspect_container('owned',run)

    def test_command_logs_are_separated_by_phase(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            root=Path(tmp)
            with patch('operator_once.guard.run_bounded',side_effect=lambda args,log,**kw:log.write_bytes(b'ok')):
                op.FixedCommands(root,op.time.monotonic(),'build')(['fixture'])
                op.FixedCommands(root,op.time.monotonic(),'registry')(['fixture'])
            self.assertEqual(len(list(root.glob('*-command-001.log'))),2)

    def test_public_package_never_runs_registry_client(self):
        with patch('operator_once.package_metadata',return_value={'visibility':'public'}), \
             patch('operator_once.FixedCommands') as commands:
            with self.assertRaises(ValueError):op.publish_existing_private(Path('/tmp/unused'),0,'1','synthetic')
        commands.assert_not_called()

    def test_inert_bootstrap_contains_no_app_bytes_layers_or_secrets(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            layout,digest,size=op.bootstrap_layout(Path(tmp),'a'*32)
            self.assertLessEqual(size,8192)
            manifest=json.loads((layout/'blobs/sha256'/digest[7:]).read_bytes())
            self.assertEqual(manifest['layers'],[])
            config=json.loads((layout/'blobs/sha256'/manifest['config']['digest'][7:]).read_bytes())
            self.assertEqual(config['rootfs']['diff_ids'],[])
            self.assertNotIn('Env',config['config'])
            self.assertNotIn(op.guard.SOURCE,json.dumps(config))

    def test_bootstrap_version_digest_is_exclusively_task_unique(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as one,tempfile.TemporaryDirectory(dir='/tmp') as two:
            self.assertNotEqual(op.bootstrap_layout(Path(one),'a'*32)[1],
                                op.bootstrap_layout(Path(two),'b'*32)[1])

    def test_bootstrap_shared_tag_version_never_deleted(self):
        payload=json.dumps([{'id':123,'name':'sha256:'+'a'*64,
                             'metadata':{'container':{'tags':['owned','other']}}}]).encode()
        class Response:
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self,n):return payload
        with patch('operator_once.urllib.request.urlopen',return_value=Response()) as request:
            with self.assertRaises(ValueError):op.delete_bootstrap('synthetic','owned','sha256:'+'a'*64)
        self.assertEqual(request.call_count,1)

    def test_bootstrap_privacy_failure_blocks_application_copy(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            calls=[]
            class Commands:
                def __init__(self,*a):pass
                def __call__(self,args,**kwargs):calls.append(args);return b''
            with patch('operator_once.FixedCommands',Commands), \
                 patch('operator_once.package_metadata',side_effect=[None,{'visibility':'public'}]):
                with self.assertRaises(ValueError):
                    op.publish_existing_private(Path(tmp),op.time.monotonic(),'1','synthetic')
            self.assertTrue(any('oci:' in ' '.join(c) for c in calls))
            self.assertFalse(any('oci-archive:' in ' '.join(c) for c in calls))
            self.assertTrue((Path(tmp)/'bootstrap-intent.json').exists())

    def test_bootstrap_cleanup_requires_exact_version_digest(self):
        payload=json.dumps([{'id':123,'name':'sha256:'+'b'*64,
                             'metadata':{'container':{'tags':['owned']}}}]).encode()
        class Response:
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self,n):return payload
        with patch('operator_once.urllib.request.urlopen',return_value=Response()) as request:
            with self.assertRaises(ValueError):op.delete_bootstrap('synthetic','owned','sha256:'+'a'*64)
        self.assertEqual(request.call_count,1)

    def test_registry_tag_collision_blocks_copy(self):
        payload=json.dumps([{'metadata':{'container':{'tags':['owned-tag']}}}]).encode()
        class Response:
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self,n):return payload
        with patch('operator_once.urllib.request.urlopen',return_value=Response()):
            with self.assertRaisesRegex(ValueError,'collision'):
                op.require_unused_registry_tag('synthetic','owned-tag')

    def test_owned_metadata_counts_no_contents_and_rejects_owner_or_symlink(self):
        spec=importlib.util.spec_from_file_location('owned_metadata',op.METADATA)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            root=Path(tmp);identity='a'*64;owner='b'*32
            metadata=root/'containers'/identity;metadata.mkdir(parents=True)
            (metadata/'config.v2.json').write_text(json.dumps({'ID':identity,'Config':{'Env':['UG_IMAGE_OWNER='+owner]}}))
            result=helper.measure(root,identity,owner)
            self.assertGreater(result['total_bytes'],0)
            with self.assertRaises(ValueError):helper.measure(root,identity,'c'*32)
            (metadata/'bad').symlink_to('/etc/hosts')
            with self.assertRaises(ValueError):helper.measure(root,identity,owner)

    def test_failure_receipt_redacts_transient_token(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            root=Path(tmp)
            (root/'failure-command.json').write_text(json.dumps({'log':'stage.log'}))
            (root/'stage.log').write_text('Bearer secret-token ghp_fake_key synthetic-token')
            result=op.failure_diagnostics(root,'synthetic-token')
        self.assertNotIn('secret-token',result['bounded_terminal_tail'])
        self.assertNotIn('fake_key',result['bounded_terminal_tail'])
        self.assertNotIn('synthetic-token',result['bounded_terminal_tail'])

    def test_failure_receipt_preserves_bounded_structure_and_completed_admission(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            root=Path(tmp)
            (root/'oci-structure.json').write_text(json.dumps({'matching_provenance_count':0}))
            (root/'admission-evidence.json').write_text(json.dumps({'kernel_cgroup':{'memory_max':'4294967296'}}))
            result=op.failure_diagnostics(root)
            self.assertEqual(result['actual_oci_structure']['matching_provenance_count'],0)
            self.assertEqual(result['completed_admission']['kernel_cgroup']['memory_max'],'4294967296')
            (root/'oci-structure.json').write_bytes(b'x'*16385)
            self.assertEqual(op.failure_diagnostics(root)['actual_oci_structure'],{'available':False})

    def test_owned_file_cleanup_preserves_only_bounded_receipt_and_operator_log(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            root=Path(tmp);(root/'work').mkdir();(root/'work'/'copy').write_text('synthetic')
            (root/'registry-auth.json').write_text('synthetic-not-a-token')
            (root/'operator.log').write_text('bounded diagnostic')
            with patch('operator_once.shutil.rmtree.avoids_symlink_attacks',True,create=True):
                op.clean_owned_files(root)
            self.assertEqual({p.name for p in root.iterdir()},{'operator.log'})


if __name__=='__main__':unittest.main(verbosity=2)
