"""One-shot, disabled-until-approved UG hosted image operator.

Parent is an independent deadline/disk watchdog; child performs fixed build,
import and fixture smoke. No general command interface, install or deployment.
Only tiny injected policy fixtures may run on this Mac.
"""
import hashlib
import ctypes
import json
import os
from pathlib import Path
import re
import resource
import signal
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

import guard

GIB = 1024**3
REPOSITORY_ID = 1196769573
TAG = 'ug-ui-image-f22738d-20261027-attempt3'
PACKAGE = 'ug-ui-verification'
BUILDER_IMAGE = 'moby/buildkit:v0.31.1'
OWNER_KEY = 'UG_IMAGE_OWNER='
WORK_SECONDS = 1140  # Final minute belongs to independent owned cleanup.
PROBE = Path(__file__).with_name('smoke-probe.mjs')
SCRATCH = Path(__file__).with_name('scratch-sample.mjs')
METADATA = Path(__file__).with_name('owned-metadata.py')
SMOKE_SAMPLES = {}


def remaining(start, reserve=60):
    value = 1200 - reserve - (time.monotonic() - start)
    if value <= 0:
        raise RuntimeError('shared deadline cleanup reserve reached')
    return value


def enforce_smoke_lease(root,run_id,owner,now):
    path=root/'smoke-lease.json'
    if not path.exists():return
    guard.regular(path,1024);lease=json.loads(path.read_bytes())
    if lease.get('name')!='ug-smoke-'+run_id or lease.get('owner')!=owner:
        raise RuntimeError('smoke lease identity invalid')
    if now-lease['start']>=90:
        raise RuntimeError('independent smoke cleanup reserve reached')


def child_environment(root):
    env = {k: os.environ[k] for k in ('PATH', 'DOCKER_HOST') if k in os.environ}
    env.update(HOME=str(root/'home'), DOCKER_CONFIG=str(root/'docker-config'),
               TMPDIR=str(root/'tmp'), LANG='C.UTF-8', TZ='UTC',
               BUILDX_METADATA_PROVENANCE='max')
    return env


def private_package(value):
    if not isinstance(value, dict) or value.get('visibility') != 'private' or \
       value.get('name') != PACKAGE or value.get('package_type') != 'container' or \
       value.get('owner', {}).get('login', '').lower() != 'muckele' or \
       value.get('repository', {}).get('id') != REPOSITORY_ID:
        projection=None if not isinstance(value,dict) else {
            'name':value.get('name'),'visibility':value.get('visibility'),
            'owner':value.get('owner',{}).get('login'),
            'repository_id':value.get('repository',{}).get('id')}
        raise ValueError('private UG package/access not established: '+json.dumps(projection,sort_keys=True))


def retention_eligible(value):
    try:
        private_package(value)
        return True
    except ValueError:
        return False


def validate_builder(b, owner):
    h = b['HostConfig']
    if OWNER_KEY+owner not in b['Config'].get('Env', []) or \
       (h.get('Memory'), h.get('MemorySwap'), h.get('CpuPeriod'), h.get('CpuQuota')) != \
       (4*GIB, 4*GIB, 100000, 200000) or h.get('CgroupnsMode') != 'private' or \
       h.get('Privileged') is not True or h.get('RestartPolicy', {}).get('Name') != 'no' or \
       h.get('NetworkMode') in ('host', 'container') or not b['State']['Running']:
        raise ValueError('builder identity/resource/namespace admission failed')


def validate_cgroup(c):
    expected={'self_cgroup':'0::/', 'memory_max':str(4*GIB), 'swap_max':'0',
              'cpu_max':'200000 100000', 'mount_root':'/'}
    # BuildKit v0.31.1 moves processes to /init to enable nested controllers.
    # These counters still come from the private enclosing namespace root.
    if c != expected and c != dict(expected,self_cgroup='0::/init'):
        raise ValueError('private enclosing kernel cgroup limits unproven: '+json.dumps(c,sort_keys=True)[:1000])


def validate_image_config(c):
    env = c.get('Env') or []
    keys = [x.split('=', 1)[0] for x in env]
    if c.get('Entrypoint') != ['docker-entrypoint.sh'] or \
       c.get('Cmd') != ['node', 'server/index.js'] or c.get('WorkingDir') != '/app' or \
       c.get('Volumes') or c.get('User', '') not in ('', 'root', '0') or \
       len(keys) != len(set(keys)) or set(keys) != {'PATH','NODE_VERSION','YARN_VERSION','NODE_ENV'} or \
       'NODE_ENV=production' not in env or not any(re.fullmatch(r'NODE_VERSION=22\.[0-9]+\.[0-9]+', x) for x in env):
        raise ValueError('unexpected image CMD/entrypoint/env/volume/user')


def smoke_create(name, image, owner):
    env = {
        'UG_IMAGE_OWNER':owner, 'DOTENV_CONFIG_PATH':'/dev/null', 'NODE_ENV':'production',
        'STORAGE_PROVIDER':'sqlite','HOST':'127.0.0.1','PORT':'8787',
        'HOME':'/tmp/ug-smoke/home','TMPDIR':'/tmp',
        'SQLITE_PATH':'/tmp/ug-smoke/fixture.sqlite',
        'SECURE_DOCUMENTS_STORAGE_DIR':'/tmp/ug-smoke/documents',
        'BACKUP_DIRECTORY':'/tmp/ug-smoke/backups',
        'DEAL_HUNTER_DAILY_EMAIL_MARKER_DIR':'/tmp/ug-smoke/digest-markers',
        'ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH':'/tmp/ug-smoke/source-health.json',
        'ADMIN_AUTH_MODE':'password','ADMIN_USERNAME':'synthetic-owner',
        'ADMIN_PASSWORD':'synthetic-only-owner-password','ADMIN_EMAIL':'owner@example.test',
        'ADMIN_SESSION_SECRET':'synthetic-only-session-secret-0000000000',
        'SECURE_DOCUMENTS_TOKEN_SECRET':'synthetic-only-document-secret-1111111111',
        'DELIVERY_PROVIDER':'resend','RESEND_API_KEY':'synthetic-only-not-a-provider-key',
        'RESEND_FROM_EMAIL':'sender@example.test','LEAD_NOTIFICATION_EMAIL':'owner@example.test',
        'CRM_PROVIDER':'console','BACKUP_ENABLED':'false','ANALYTICS_ENABLED':'false',
        'DEAL_HUNTER_AIRTABLE_ENABLED':'false','DEAL_HUNTER_SHEET_CSV_URL':'',
        'DEAL_HUNTER_SHEET_CSV_URLS':'','DEAL_HUNTER_DAILY_EMAIL_ENABLED':'false',
        'DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED':'false',
        'DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED':'false',
        'DEAL_HUNTER_CIM_AUTOMATION_PAUSED':'true','DEAL_HUNTER_CIM_OUTREACH_PAUSED':'true',
        'FOLLOW_UP_EMAIL_ENABLED':'false','FOLLOW_UP_AI_ENABLED':'false',
        'DEAL_HUNTER_CIM_PROVIDER_ENABLED':'false'}
    args = ['docker','create','--name',name,'--label','ug.image.owner='+owner,
            '--network','none','--read-only','--cap-drop','ALL',
            '--security-opt','no-new-privileges','--memory','512m','--memory-swap','512m',
            '--cpus','2','--pids-limit','128','--shm-size','1m',
            '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=240m',
            '--log-driver','local','--log-opt','max-size=512k','--log-opt','max-file=1',
            '--restart','no']
    for k,v in env.items():args += ['--env', k+'='+v]
    return args+[image]  # No entrypoint/command override or bind/real-data mount.


def inspect_container(name, run):
    try:
        raw = run(['docker','inspect','--type','container',name])
    except subprocess.CalledProcessError as e:
        text = (e.stderr or b'').decode(errors='replace')
        if e.returncode == 1 and re.search(r'No such (?:object|container): '+re.escape(name)+r'\s*$', text):
            return None
        raise
    value = json.loads(raw)
    if len(value) != 1:raise ValueError('ambiguous inspect result')
    return value[0]


def cleanup_objects(run_id, owner, run):
    """Never broad-filter a mutation. Revalidate nonce and exact ID first."""
    result = {'verified':True,'objects':[]}
    builder='buildx_buildkit_ug-image-'+run_id
    for name in ('ug-smoke-'+run_id,builder):
        try:
            b = inspect_container(name, run)
            if b is None:
                result['objects'].append({'name':name,'absent':True,'verified_at':time.monotonic()})
                continue
            if OWNER_KEY+owner not in b.get('Config', {}).get('Env', []) or \
               b.get('Name') != '/'+name or not re.fullmatch('[0-9a-f]{64}',b.get('Id','')):
                raise ValueError('foreign or uncertain object: '+name)
            identity=b['Id']
            volumes=[x['Name'] for x in b.get('Mounts',[]) if x.get('Type')=='volume']
            if b.get('State',{}).get('Running'):
                try:run(['docker','stop','--time','5',identity])
                except (subprocess.TimeoutExpired,subprocess.CalledProcessError):
                    # Check the uncertain stop before the planned forced abort.
                    fresh=inspect_container(name,run)
                    if fresh is None or fresh['Id']!=identity or \
                       OWNER_KEY+owner not in fresh['Config'].get('Env',[]):
                        raise ValueError('owned stop outcome/identity uncertain')
                    if fresh['State']['Running']:run(['docker','kill','--signal','KILL',identity])
            current=inspect_container(name,run)
            if current is None or current['Id']!=identity or current['State']['Running']:
                raise ValueError('owned exit/replacement uncertain')
            run(['docker','rm',identity])
            if inspect_container(name,run) is not None:
                raise ValueError('owned container absence uncertain')
            if name==builder:
                result['builder_container_absence_verified']=True
                expected=builder+'_state'
                if volumes != [expected]:raise ValueError('unexpected builder volume binding')
                try:run(['docker','volume','rm',expected])
                except subprocess.TimeoutExpired:
                    # Deletion may finish in the daemon after its CLI times out.
                    # Reconcile with one exact read; never retry the mutation.
                    if run(['docker','volume','ls','-q','--filter','name=^'+expected+'$']).strip():
                        raise ValueError('owned volume removal timeout; absence unproven')
                    result['volume_removal_timeout_reconciled']=True
            result['objects'].append({'name':name,'id':identity,'absent':True,'verified_at':time.monotonic()})
        except Exception as e:
            result['verified']=False
            result['objects'].append({'name':name,'error':str(e)[:300],'preserved_on_uncertainty':True})
    # A partially created orphan volume has no verified owner binding: preserve.
    try:
        leftovers=run(['docker','volume','ls','-q','--filter','name=^'+builder+'_state$']).strip()
        if leftovers:
            result['verified']=False
            result['orphan_volume_preserved']=True
        result['volume_absence_verified']=not bool(leftovers)
    except Exception as e:
        result['verified']=False;result['absence_error']=str(e)[:300]
    return result


def reap_control_children():
    """Subreaper owns escaped/orphaned CLI helpers; pidfds prevent PID reuse."""
    deadline=time.monotonic()+3
    killed=[]
    while time.monotonic()<deadline:
        pids=[int(x) for x in Path('/proc/self/task/'+str(os.getpid())+'/children').read_text().split()]
        if len(pids)>64:raise RuntimeError('control descendant count cap')
        for pid in pids:
            try:
                text=Path('/proc/'+str(pid)+'/stat').read_text()
                values=text[text.rfind(')')+2:].split()
                if int(values[1])!=os.getpid():raise RuntimeError('adopted helper ownership uncertain')
                start=values[19]
                fd=os.pidfd_open(pid)
                try:
                    again=Path('/proc/'+str(pid)+'/stat').read_text()
                    values2=again[again.rfind(')')+2:].split()
                    if values2[19]!=start or int(values2[1])!=os.getpid():
                        raise RuntimeError('adopted helper identity changed')
                    signal.pidfd_send_signal(fd,signal.SIGKILL)
                    killed.append({'pid':pid,'start_ticks':start})
                finally:os.close(fd)
            except ProcessLookupError:pass
            except FileNotFoundError:
                # ECHILD below, not this race, establishes final absence.
                pass
        while True:
            try:
                pid,_=os.waitpid(-1,os.WNOHANG)
                if pid==0:break
            except ChildProcessError:
                if Path('/proc/self/task/'+str(os.getpid())+'/children').read_text().strip():
                    raise RuntimeError('ECHILD/descendant snapshot disagreement')
                return {'ECHILD':True,'terminated_adopted_helpers':killed}
        time.sleep(.02)
    raise RuntimeError('control descendant absence unverified')


def sample_smoke(identity,owner,root,start,smoke_start,force=False):
    previous=SMOKE_SAMPLES.setdefault(identity,{'samples':0,'last':0,'peak_bytes':0,
                                             'peak_metadata_bytes':0,'peak_dev_bytes':0})
    now=time.monotonic()
    if not force and now-previous['last']<.5:return previous
    if now-smoke_start>100:raise RuntimeError('smoke cleanup reserve reached')
    remaining(start)
    runtime=json.loads(raw_docker(['docker','exec',identity,'node','--max-old-space-size=32',
                        '--input-type=module','-e',SCRATCH.read_text()],timeout=3))
    p=subprocess.run(['sudo','-n','/usr/bin/python3',str(METADATA),identity,owner],
                     capture_output=True,timeout=3,env={'PATH':'/usr/bin:/bin'})
    if p.returncode or len(p.stdout)>65536 or len(p.stderr)>65536:
        raise ValueError('owned metadata accounting unavailable')
    metadata=json.loads(p.stdout)
    receipts=sum(max(x.stat().st_size,x.stat().st_blocks*512) for x in root.glob('build-command-*.log'))
    # Conservatively count every command receipt and reserve final 512KiB receipt.
    receipts+=guard.RECEIPT_MAX
    if receipts>guard.MIB or metadata['log_bytes']>guard.MIB or \
       metadata['ancillary_bytes']+runtime['dev_bytes']>13*guard.MIB or \
       runtime['tmp_bytes']>240*guard.MIB or runtime['shm_bytes']>guard.MIB:
        raise ValueError('smoke component scratch/receipt limit')
    total=runtime['tmp_bytes']+runtime['shm_bytes']+runtime['dev_bytes']+metadata['total_bytes']+receipts
    if total>256*guard.MIB:raise ValueError('aggregate smoke scratch limit')
    previous.update(samples=previous['samples']+1,last=now,
                    peak_bytes=max(previous['peak_bytes'],total),
                    peak_metadata_bytes=max(previous['peak_metadata_bytes'],metadata['total_bytes']),
                    peak_dev_bytes=max(previous['peak_dev_bytes'],runtime['dev_bytes']))
    return previous


class FixedCommands:
    def __init__(self, root, start, phase='build'):
        self.root,self.start,self.count=root,start,0
        self.env=child_environment(root)
        self.phase=phase
        self.monitor=None

    def __call__(self,args,seconds=10,stdin=None,env=None):
        self.count+=1
        if self.count>100:raise RuntimeError('fixed operation count exceeded')
        log=self.root/(self.phase+'-command-%03d.log'%self.count)
        try:
            guard.run_bounded(args,log,seconds=min(seconds,remaining(self.start)),
                              env=env or self.env,stdin_data=stdin,new_session=False,
                              monitor=self.monitor)
        except Exception:
            record=self.root/'failure-command.json'
            if not record.exists():
                guard.bounded_json(record,{'phase':self.phase,'command':args[:3],
                                          'log':log.name,'completed':False})
            raise
        return log.read_bytes()


def get_public_repository():
    request=urllib.request.Request('https://api.github.com/repos/muckele/uckele-group',
                                   headers={'Accept':'application/vnd.github+json'})
    with urllib.request.urlopen(request,timeout=10) as r:
        raw=r.read(131073)
    if len(raw)>131072:raise ValueError('repository metadata cap')
    value=json.loads(raw)
    if value.get('id')!=REPOSITORY_ID or value.get('private') is not False or \
       value.get('visibility')!='public':raise ValueError('repository visibility drift')


def workload(root, source, start, run_id, owner):
    run=FixedCommands(root,start)
    get_public_repository()
    source_binding=guard.prepare(source,root/'work')
    guard.bounded_json(root/'work/source-binding.json',source_binding)
    builder='ug-image-'+run_id
    container='buildx_buildkit_'+builder
    # Names and tag were proven absent by the independent owner before creation.
    run(['docker','buildx','create','--name',builder,'--node',builder,
         '--driver','docker-container','--driver-opt',
         'image='+BUILDER_IMAGE+',memory=4g,memory-swap=4g,cpu-period=100000,'+
         'cpu-quota=200000,restart-policy=no,env.UG_IMAGE_OWNER='+owner],seconds=30)
    run(['docker','buildx','inspect',builder,'--bootstrap'],seconds=min(120,start+900-time.monotonic()))
    b=json.loads(run(['docker','inspect',container]))[0]
    validate_builder(b,owner)
    cgroup_script='''printf '{"self_cgroup":"%s","memory_max":"%s","swap_max":"%s","cpu_max":"%s","mount_root":"%s"}' "$(cat /proc/self/cgroup)" "$(cat /sys/fs/cgroup/memory.max)" "$(cat /sys/fs/cgroup/memory.swap.max)" "$(cat /sys/fs/cgroup/cpu.max)" "$(awk '$0 ~ / - cgroup2 / {print $4}' /proc/self/mountinfo)"'''
    cg=json.loads(run(['docker','exec',b['Id'],'sh','-c',cgroup_script]))
    validate_cgroup(cg)
    free=json.loads(run(['docker','exec',b['Id'],'sh','-c',
        '''printf '{"free_kib":%s}' "$(df -Pk /var/lib/buildkit | awk 'NR==2 {print $4}')"''']))
    if free['free_kib']*1024<5*GIB:raise ValueError('guest disk admission')
    guard.bounded_json(root/'admission-evidence.json',{
        'source_export':{k:source_binding[k] for k in
            ['context_tar_sha256','context_tar_bytes','tracked_files','recipe_hashes']},
        'resolved_builder_image_id':b['Image'],'kernel_cgroup':cg,
        'guest_disk_free_bytes':free['free_kib']*1024},maximum=16384)
    out=root/'candidate.oci.tar';meta=root/'metadata.json'
    build_seconds=min(start+900-time.monotonic(),remaining(start))
    if build_seconds<=0:raise RuntimeError('15 minute build window exhausted')
    run(['docker','buildx','build','--builder',builder,'--platform','linux/amd64',
         '--tag','ug-ui-qualification:'+run_id,
         '--provenance=mode=max,version=v0.2','--metadata-file',str(meta),
         '--output','type=oci,dest='+str(out),
         '--label','org.opencontainers.image.revision='+guard.SOURCE,
         '--label','org.opencontainers.image.source=https://github.com/muckele/uckele-group',
         str(root/'work/context')],seconds=build_seconds)
    guard.regular(meta,guard.RECEIPT_MAX)
    structure={}
    try:image=guard.inspect_oci(out,diagnostics=structure)
    finally:guard.bounded_json(root/'oci-structure.json',structure,maximum=16384)
    guard.validate_binding(image,json.loads(meta.read_bytes()),source_binding,root/'work/context',
                           diagnostic_path=root/'provenance-comparison.json')
    # Release builder RAM before the fixed import/fixture phase; owner removes it.
    run(['docker','stop','--time','5',b['Id']])
    local='ug-ui-qualification:'+run_id
    # Existing preinstalled Skopeo converts the runnable leaf for Docker's classic
    # store. The original OCI/index/provenance is retained unchanged for GHCR.
    guard.bounded_json(root/'local-image-intent.json',{'tag':local,'config_digest':image['config_digest']})
    existing=run(['docker','image','ls','--no-trunc','--quiet']).decode().splitlines()
    if image['config_digest'] in existing:raise ValueError('candidate image object predates owned import')
    run(['skopeo','copy','--override-os','linux','--override-arch','amd64',
         'oci-archive:'+str(out),'docker-daemon:'+local],seconds=60)
    imported=json.loads(run(['docker','image','inspect',local]))[0]
    expected=image['image_config']
    if imported.get('Id')!=image['config_digest'] or \
       imported.get('RootFS',{}).get('Layers')!=expected.get('rootfs',{}).get('diff_ids'):
        raise ValueError('imported runtime config/rootfs identity mismatch')
    validate_image_config(imported['Config'])
    smoke_start=time.monotonic();name='ug-smoke-'+run_id
    lease={'start':smoke_start,'name':name,'owner':owner,'deadline_seconds':120}
    guard.bounded_json(root/'smoke-lease.partial',lease,maximum=1024)
    os.rename(root/'smoke-lease.partial',root/'smoke-lease.json')
    run(smoke_create(name,local,owner))
    created=json.loads(run(['docker','inspect',name]))[0]
    validate_smoke_settings(created,owner,image['config_digest'])
    run(['docker','start',created['Id']])
    run.monitor=lambda: sample_smoke(created['Id'],owner,root,start,smoke_start)
    while True:
        logs=run(['docker','logs',created['Id']])
        state=json.loads(run(['docker','inspect',created['Id']]))[0]['State']
        if not state['Running']:raise ValueError('entrypoint exited before readiness')
        if b'Uckele Group backend listening on 127.0.0.1:8787' in logs:break
        if time.monotonic()-smoke_start>45:raise RuntimeError('startup readiness deadline')
        time.sleep(.2)
    probe=run(['docker','exec','--workdir','/app',created['Id'],'node',
               '--max-old-space-size=64','--input-type=module','-e',PROBE.read_text()],seconds=20)
    smoke=json.loads(probe)
    sample_smoke(created['Id'],owner,root,start,smoke_start,force=True)
    run.monitor=None  # The shutdown interval is separately bounded below.
    run(['docker','stop','--time','12',created['Id']],seconds=15)
    terminal=json.loads(run(['docker','inspect',created['Id']]))[0]['State']
    logs=run(['docker','logs',created['Id']])
    if terminal['Running'] or terminal.get('ExitCode')!=0 or terminal.get('OOMKilled') or \
       b'[server] SIGTERM received; stopping schedulers and HTTP server' not in logs or \
       b'graceful shutdown timed out' in logs or time.monotonic()-smoke_start>120:
        raise ValueError('entrypoint graceful shutdown/deadline failed')
    run(['docker','rm',created['Id']])
    if inspect_container(name,raw_docker) is not None:raise ValueError('smoke owned absence unverified')
    if time.monotonic()-smoke_start>120:raise RuntimeError('smoke cleanup exceeded 120 seconds')
    guard.bounded_json(root/'smoke-closed.partial',dict(lease,closed_at=time.monotonic(),id=created['Id']),maximum=1024)
    os.rename(root/'smoke-closed.partial',root/'smoke-closed.json')
    return {'source':guard.SOURCE,'tree':guard.TREE,'image':image,
            'source_export':{k:source_binding[k] for k in
               ['context_tar_sha256','context_tar_bytes','tracked_files','recipe_hashes']},
            'build_metadata_sha256':guard.digest(meta),
            'resolved_builder_image_id':b['Image'],'kernel_cgroup':cg,
            'smoke':smoke,'smoke_seconds':round(time.monotonic()-smoke_start,3),
            'sampled_smoke_scratch':{k:v for k,v in SMOKE_SAMPLES[created['Id']].items() if k!='last'},
            'graceful_exit_code':terminal['ExitCode'],'local_tag':local,
            'scope':'actual unchanged entrypoint on fresh fixture; no periodic callback or provider qualification'}


def validate_smoke_settings(c,owner,image_id):
    h=c['HostConfig'];mounts=c.get('Mounts') or []
    tmpfs=h.get('Tmpfs') or {}
    if c.get('Image')!=image_id or OWNER_KEY+owner not in c['Config'].get('Env',[]) or \
       c['Config'].get('Entrypoint')!=['docker-entrypoint.sh'] or \
       c['Config'].get('Cmd')!=['node','server/index.js'] or h.get('Privileged') or \
       h.get('NetworkMode')!='none' or not h.get('ReadonlyRootfs') or \
       h.get('Memory')!=512*guard.MIB or h.get('MemorySwap')!=512*guard.MIB or \
       h.get('NanoCpus')!=2000000000 or h.get('ShmSize')!=guard.MIB or \
       set(tmpfs)!={'/tmp'} or tmpfs['/tmp']!='rw,nosuid,nodev,noexec,size=240m' or \
       h.get('PortBindings') or h.get('Binds') or h.get('Devices') or \
       h.get('PidMode') or h.get('IpcMode') not in ('private','') or h.get('PidsLimit')!=128 or \
       h.get('RestartPolicy',{}).get('Name')!='no' or \
       h.get('LogConfig')!={'Type':'local','Config':{'max-size':'512k','max-file':'1'}} or \
       set(h.get('CapDrop') or [])!={'ALL'} or \
       'no-new-privileges' not in (h.get('SecurityOpt') or []) or \
       any(m.get('Type')!='tmpfs' or m.get('Destination') not in ('/tmp','/dev/shm') for m in mounts):
        raise ValueError('unexpected smoke identity/isolation/resource settings')
    expected=smoke_create('unused','unused',owner)
    supplied={expected[i+1] for i,x in enumerate(expected[:-1]) if x=='--env'}
    base={x for x in c['Config'].get('Env',[]) if x.split('=',1)[0] in ('PATH','NODE_VERSION','YARN_VERSION')}
    if set(c['Config'].get('Env',[]))!=supplied|base or len(base)!=3:
        raise ValueError('smoke runtime environment drift')


def package_metadata(token):
    req=urllib.request.Request('https://api.github.com/users/muckele/packages/container/'+PACKAGE,
        headers={'Accept':'application/vnd.github+json','Authorization':'Bearer '+token})
    try:
        with urllib.request.urlopen(req,timeout=10) as response:
            raw=response.read(guard.RECEIPT_MAX+1)
        if len(raw)>guard.RECEIPT_MAX:raise ValueError('package metadata cap')
        return json.loads(raw)
    except urllib.error.HTTPError as e:
        if e.code==404:return None
        if e.code==403:raise PermissionError('package metadata forbidden; no permission expansion') from None
        raise RuntimeError('package API HTTP '+str(e.code)) from None


def require_unused_registry_tag(token,tag):
    # Refuse to overwrite a prior publication, even on a repeated operator call.
    for page in range(1,11):
        url='https://api.github.com/users/muckele/packages/container/'+PACKAGE+\
            '/versions?per_page=100&page='+str(page)
        req=urllib.request.Request(url,headers={'Accept':'application/vnd.github+json',
                                              'Authorization':'Bearer '+token})
        with urllib.request.urlopen(req,timeout=10) as response:
            raw=response.read(guard.RECEIPT_MAX+1)
        if len(raw)>guard.RECEIPT_MAX:raise ValueError('package version metadata cap')
        versions=json.loads(raw)
        if not isinstance(versions,list):raise ValueError('package version schema')
        if any(tag in x.get('metadata',{}).get('container',{}).get('tags',[]) for x in versions):
            raise ValueError('pre-existing registry tag collision')
        if len(versions)<100:return
    raise ValueError('cannot prove unused tag within version-list bound')


def bootstrap_layout(root,nonce):
    """Fixed inert image, never app bytes. Payload at most8KiB, no build/run."""
    layout=root/'privacy-bootstrap'
    if not re.fullmatch('[0-9a-f]{32}',nonce):raise ValueError('invalid inert owner nonce')
    (layout/'blobs/sha256').mkdir(parents=True,mode=0o700)
    def blob(value):
        data=json.dumps(value,sort_keys=True,separators=(',',':')).encode()
        dg=hashlib.sha256(data).hexdigest()
        (layout/'blobs/sha256'/dg).write_bytes(data)
        return {'digest':'sha256:'+dg,'size':len(data)}
    config=blob({'architecture':'amd64','os':'linux','config':{'Labels':{
        'org.opencontainers.image.source':'https://github.com/muckele/uckele-group',
        'ug.image.inert-privacy-bootstrap':'true','ug.image.bootstrap-owner':nonce}},
        'rootfs':{'type':'layers','diff_ids':[]},'history':[]})
    manifest=blob({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json',
        'config':dict(config,mediaType='application/vnd.oci.image.config.v1+json'),'layers':[]})
    (layout/'oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}')
    (layout/'index.json').write_text(json.dumps({'schemaVersion':2,'manifests':[
        dict(manifest,mediaType='application/vnd.oci.image.manifest.v1+json',
             annotations={'org.opencontainers.image.ref.name':'bootstrap'},
             platform={'os':'linux','architecture':'amd64'})]}))
    size=sum(p.stat().st_size for p in layout.rglob('*') if p.is_file())
    if size>8192:raise ValueError('inert bootstrap payload cap')
    return layout,manifest['digest'],size


def delete_bootstrap(token,tag,expected):
    url='https://api.github.com/users/muckele/packages/container/'+PACKAGE+'/versions?per_page=100'
    req=urllib.request.Request(url,headers={'Accept':'application/vnd.github+json','Authorization':'Bearer '+token})
    with urllib.request.urlopen(req,timeout=10) as response:raw=response.read(guard.RECEIPT_MAX+1)
    if len(raw)>guard.RECEIPT_MAX:raise ValueError('bootstrap version response cap')
    found=[v for v in json.loads(raw) if tag in v.get('metadata',{}).get('container',{}).get('tags',[])]
    if len(found)!=1 or found[0].get('name')!=expected or not isinstance(found[0].get('id'),int) or \
       found[0].get('metadata',{}).get('container',{}).get('tags')!=[tag]:
        raise ValueError('bootstrap version ownership not established; preserved')
    version=found[0]['id']
    req=urllib.request.Request('https://api.github.com/users/muckele/packages/container/'+PACKAGE+'/versions/'+str(version),
        method='DELETE',headers={'Accept':'application/vnd.github+json','Authorization':'Bearer '+token})
    with urllib.request.urlopen(req,timeout=10) as response:
        if response.status!=204:raise RuntimeError('bootstrap cleanup not confirmed')
    req=urllib.request.Request('https://api.github.com/users/muckele/packages/container/'+PACKAGE+'/versions/'+str(version),
        headers={'Accept':'application/vnd.github+json','Authorization':'Bearer '+token})
    try:
        with urllib.request.urlopen(req,timeout=10):pass
    except urllib.error.HTTPError as e:
        if e.code==404:return {'deleted_version_id':version,'digest':expected,'absence_verified':True}
        raise RuntimeError('bootstrap absence verification HTTP '+str(e.code)) from None
    raise RuntimeError('bootstrap version still present after delete')


def publish_existing_private(root,start,run_id,token):
    # Never use app bytes to discover privacy. Existing public/unassociated
    # packages fail; an absent package may receive only the fixed inert payload.
    before=package_metadata(token)
    if before is not None:private_package(before)
    tag='f22738d-run-'+run_id
    ref='ghcr.io/muckele/'+PACKAGE+':'+tag
    run=FixedCommands(root,start,'registry')
    auth=root/'registry-auth.json'
    # Credential only enters the fixed registry client via stdin, after source
    # build and app/container exit. Never an ARG, source env or public receipt.
    bootstrap=None
    try:
        run(['skopeo','login','--authfile',str(auth),'--username','muckele',
             '--password-stdin','ghcr.io'],stdin=token.encode()+b'\n')
        if before is None:
            bootstrap_nonce=uuid.uuid4().hex
            layout,dg,size=bootstrap_layout(root,bootstrap_nonce)
            bootstrap_tag='privacy-bootstrap-'+run_id+'-'+bootstrap_nonce
            bootstrap={'tag':bootstrap_tag,'reference':'ghcr.io/muckele/'+PACKAGE+':'+bootstrap_tag,
                       'digest':dg,'payload_bytes':size,
                       'contains_application_bytes':False}
            guard.bounded_json(root/'bootstrap-intent.json',bootstrap)
            run(['skopeo','copy','--preserve-digests','--authfile',str(auth),
                 'oci:'+str(layout)+':bootstrap',
                 'docker://ghcr.io/muckele/'+PACKAGE+':'+bootstrap_tag],seconds=30)
            private_package(package_metadata(token))
        require_unused_registry_tag(token,tag)
        private_package(package_metadata(token))
        guard.bounded_json(root/'registry-intent.json',{'reference':ref,'private_prechecked':True,
                            'phase':'copy-not-yet-verified'})
        run(['skopeo','copy','--all','--preserve-digests','--authfile',str(auth),
             'oci-archive:'+str(root/'candidate.oci.tar'),'docker://'+ref],seconds=60)
        raw=run(['skopeo','inspect','--raw','--authfile',str(auth),'docker://'+ref])
        expected=json.loads((root/'workload-result.json').read_bytes())['image']['result_root_digests']
        actual='sha256:'+hashlib.sha256(raw).hexdigest()
        if actual not in expected:raise ValueError('registry root digest changed')
        private_package(package_metadata(token))
        guard.bounded_json(root/'registry-verified.json',{'retained':True,'reference':ref,'digest':actual,
                            'visibility_verified':'private','bootstrap_cleanup':'not-yet-verified'})
        if bootstrap:
            # Missing delete authority is reported; no credential/scope change.
            bootstrap['cleanup']=delete_bootstrap(token,bootstrap['tag'],bootstrap['digest'])
        return {'retained':True,'visibility_verified':'private','reference':ref,
                'digest':actual,'verified_private_before_application_upload':True,'bootstrap':bootstrap,
                'scope':'verified repository-associated private package; no visibility/ACL change'}
    finally:
        # Auth file is positively owned, created only by the fixed client here.
        if auth.exists():
            guard.regular(auth,65536);auth.unlink()


def raw_docker(args,timeout=5):
    p=subprocess.run(args,capture_output=True,timeout=timeout,
                     env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),
                          'DOCKER_HOST':'unix:///var/run/docker.sock',
                          'DOCKER_CONFIG':os.environ.get('UG_OWNED_DOCKER_CONFIG','/nonexistent-ug-config')})
    if len(p.stdout)+len(p.stderr)>guard.RECEIPT_MAX:raise ValueError('cleanup output cap')
    if p.returncode:raise subprocess.CalledProcessError(p.returncode,args,stderr=p.stderr)
    return p.stdout


def failure_diagnostics(root,token=''):
    result={}
    path=root/'failure-command.json'
    if path.exists():
        guard.regular(path,guard.RECEIPT_MAX);result=json.loads(path.read_bytes())
        log=root/result['log']
        try:
            guard.regular(log,guard.LOG_MAX)
            text=log.read_bytes()[-8192:].decode(errors='replace')
        except (ValueError,OSError) as e:
            result['log_unavailable']=type(e).__name__
            return result
        if token:text=text.replace(token,'[redacted]')
        text=re.sub(r'gh[pousr]_[A-Za-z0-9_]+','[redacted]',text)
        text=re.sub(r'(?i)Bearer\s+[A-Za-z0-9_.-]+','Bearer [redacted]',text)
        result['bounded_terminal_tail']=text
    operator=root/'operator.log'
    if operator.exists():
        text=operator.read_bytes()[-8192:].decode(errors='replace')
        if token:text=text.replace(token,'[redacted]')
        text=re.sub(r'gh[pousr]_[A-Za-z0-9_]+','[redacted]',text)
        text=re.sub(r'(?i)Bearer\s+[A-Za-z0-9_.-]+','Bearer [redacted]',text)
        result['bounded_operator_tail']=text
    metadata=root/'metadata.json'
    if metadata.exists():
        try:
            guard.regular(metadata,guard.RECEIPT_MAX)
            m=json.loads(metadata.read_bytes());p=m.get('buildx.build.provenance',{})
            result['actual_metadata_projection']={'sha256':guard.digest(metadata),
                'result_digest':m.get('containerimage.digest'),
                'config_digest':m.get('containerimage.config.digest'),
                'provenance_keys':sorted(p),'buildType':p.get('buildType')}
        except (ValueError,OSError):result['metadata_available']=False
    for name,key,maximum in [('oci-structure.json','actual_oci_structure',16384),
                     ('admission-evidence.json','completed_admission',16384),
                     ('provenance-comparison.json','provenance_comparison',8192)]:
        path=root/name
        if path.exists():
            try:
                guard.regular(path,maximum);result[key]=json.loads(path.read_bytes())
            except (ValueError,OSError):result[key]={'available':False}
    return result


def clean_owned_files(root):
    if not shutil.rmtree.avoids_symlink_attacks:raise RuntimeError('safe owned directory cleanup unavailable')
    for p in list(root.iterdir()):
        if p.name in ('receipt.json','operator.log'):continue
        s=p.lstat()
        if stat.S_ISDIR(s.st_mode):shutil.rmtree(p)
        elif stat.S_ISREG(s.st_mode) and s.st_nlink==1:p.unlink()
        else:raise ValueError('unexpected owned scratch object preserved')
    return {'owned_temporary_copies_removed':True,'retained_files':['receipt.json','operator.log']}


def admission(start):
    e=os.environ
    if e.get('RUNNER_ENVIRONMENT')!='github-hosted' or e.get('RUNNER_OS')!='Linux' or \
       e.get('RUNNER_ARCH')!='X64' or e.get('GITHUB_REPOSITORY')!='muckele/uckele-group' or \
       e.get('GITHUB_REPOSITORY_ID')!=str(REPOSITORY_ID) or \
       e.get('GITHUB_REF')!='refs/tags/'+TAG or e.get('GITHUB_RUN_ATTEMPT')!='1':
        raise ValueError('exact public hosted one-shot trigger not established')
    event=json.loads(Path(e['GITHUB_EVENT_PATH']).read_bytes())
    if event.get('created') is not True or event.get('deleted') is not False or \
       event.get('repository',{}).get('private') is not False:raise ValueError('creation-only public event required')
    if not re.fullmatch('[0-9]{1,20}',e.get('GITHUB_RUN_ID','')):raise ValueError('invalid run identity')
    if not 0<=time.monotonic()-start<120:raise ValueError('missing/stale job-start deadline')
    info=json.loads(raw_docker(['docker','info','--format','{{json .}}']))
    if info.get('DockerRootDir')!='/var/lib/docker' or \
       info.get('OSType')!='linux' or info.get('Architecture') not in ('x86_64','amd64') or \
       info.get('CgroupVersion')!='2' or not all(info.get(k) for k in
       ['MemoryLimit','SwapLimit','CpuCfsPeriod','CpuCfsQuota']):raise ValueError('native Docker control support unavailable')
    available=None
    for line in Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):available=int(line.split()[1])*1024
    if available is None or available<5*GIB:
        raise ValueError('fresh memory admission failed: MemAvailable_bytes='+str(available))
    return info


def owner(source,retain):
    start=json.loads((Path(os.environ['RUNNER_TEMP'])/'ug-image-job-start.json').read_bytes())['monotonic']
    subreaper=ctypes.CDLL(None,use_errno=True)
    if subreaper.prctl(36,1,0,0,0)!=0:raise RuntimeError('process-local subreaper unavailable')
    if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):
        raise RuntimeError('identity-safe adopted-control cleanup unavailable')
    os.environ['DOCKER_HOST']='unix:///var/run/docker.sock'
    info=admission(start);run_id=os.environ['GITHUB_RUN_ID'];nonce=uuid.uuid4().hex
    root=Path(os.environ['RUNNER_TEMP'])/('ug-image-once-'+run_id)
    root.mkdir(mode=0o700)
    for sub in ['home','tmp','docker-config']:(root/sub).mkdir(mode=0o700)
    os.environ['UG_OWNED_DOCKER_CONFIG']=str(root/'docker-config')
    docker_root=Path(info['DockerRootDir'])
    paths=[root,docker_root];initial={str(p):os.statvfs(p).f_bavail*os.statvfs(p).f_frsize for p in paths}
    if os.stat(root).st_dev!=os.stat(docker_root).st_dev or \
       initial[str(root)]<29*GIB or initial[str(docker_root)]<29*GIB:
        raise ValueError('same-filesystem fresh 29 GiB disk admission failed; no builder created: '+
            json.dumps({'runner_free_bytes':initial[str(root)],'docker_free_bytes':initial[str(docker_root)],
                        'runner_device':os.stat(root).st_dev,'docker_device':os.stat(docker_root).st_dev}))
    # Stop before any mutation if a colliding object/volume/tag already exists.
    for name in ['ug-smoke-'+run_id,'buildx_buildkit_ug-image-'+run_id]:
        if inspect_container(name,raw_docker) is not None:raise ValueError('pre-existing container collision')
    if raw_docker(['docker','volume','ls','-q','--filter',
                  'name=^buildx_buildkit_ug-image-'+run_id+'_state$']).strip():raise ValueError('pre-existing volume collision')
    if raw_docker(['docker','image','ls','-q','ug-ui-qualification:'+run_id]).strip():raise ValueError('pre-existing image tag collision')
    result={'source':guard.SOURCE,'completed':False,'retention':{'retained':False},
            'limits':{'total_seconds':1200,'build_window_seconds':900,'builder_memory_bytes':4*GIB,
                      'builder_CPUs':2,'additional_swap_bytes':0,'growth_stop_bytes':8*GIB}}
    log=root/'operator.log';max_growth=0;max_interval=0;last=time.monotonic();failure=None
    def supervise(mode,extra_env=None):
        nonlocal max_growth,max_interval,last
        env=child_environment(root)
        if extra_env:env.update(extra_env)
        command=[sys.executable,__file__,mode,str(root),str(source),str(start),run_id,nonce]
        def limits():resource.setrlimit(resource.RLIMIT_FSIZE,(guard.IMAGE_MAX,guard.IMAGE_MAX))
        with open(log,'ab') as output:
            p=subprocess.Popen(command,stdout=output,stderr=subprocess.STDOUT,env=env,
                               start_new_session=True,preexec_fn=limits)
            try:
                while p.poll() is None:
                    now=time.monotonic();max_interval=max(max_interval,now-last);last=now
                    if now-start>=WORK_SECONDS:raise RuntimeError('independent total deadline cleanup reserve')
                    enforce_smoke_lease(root,run_id,nonce,now)
                    for path in paths:
                        s=os.statvfs(path);current=s.f_bavail*s.f_frsize
                        floor=20*GIB
                        growth=max(0,initial[str(path)]-current);max_growth=max(max_growth,growth)
                        if current<floor or growth>8*GIB:raise RuntimeError('independent disk floor/growth guard')
                    if log.stat().st_size>guard.LOG_MAX:raise RuntimeError('operator output limit')
                    time.sleep(.1)
                if p.returncode:raise RuntimeError('fixed '+mode+' child failed; bounded operator log retained')
            finally:
                if p.poll() is None:
                    os.killpg(p.pid,signal.SIGKILL)
                p.wait(timeout=3)
                reap_control_children()
    try:
        supervise('workload')
        lease=json.loads((root/'smoke-lease.json').read_bytes())
        closed=json.loads((root/'smoke-closed.json').read_bytes())
        if closed.get('owner')!=nonce or closed.get('name')!=lease['name'] or \
           closed.get('start')!=lease['start'] or closed.get('closed_at',float('inf'))-lease['start']>120 or \
           inspect_container(lease['name'],raw_docker) is not None or time.monotonic()-lease['start']>120:
            raise ValueError('independent smoke absence/deadline verification failed')
        independent_smoke_absence_seconds=round(time.monotonic()-lease['start'],3)
        (root/'smoke-lease.json').unlink()  # Only ancestor retires the checked lease.
        guard.regular(root/'workload-result.json',guard.RECEIPT_MAX)
        result.update(json.loads((root/'workload-result.json').read_bytes()))
        result['completed']=True
        result['independent_smoke_absence_seconds']=independent_smoke_absence_seconds
        if retain:
            token=os.environ.get('RETENTION_TOKEN','')
            if not token:raise ValueError('optional transient package token missing')
            result['retention']={'retained':None,'outcome':'optional registry operation not yet verified'}
            supervise('publish',{'RETENTION_TOKEN':token})
            result['retention']=json.loads((root/'retention-result.json').read_bytes())
    except BaseException as e:
        failure=type(e).__name__+': '+str(e)[:400]
    finally:
        try:controls=reap_control_children()
        except Exception as e:controls={'ECHILD':False,'error':str(e)[:200]}
        def cleanup_run(args):
            left=1200-(time.monotonic()-start)-5
            if left<=0:raise RuntimeError('cleanup deadline exhausted')
            return raw_docker(args,timeout=min(3,left))
        lease=None
        if (root/'smoke-lease.json').exists():
            lease=json.loads((root/'smoke-lease.json').read_bytes())
        cleanup=cleanup_objects(run_id,nonce,cleanup_run)
        if lease:
            smoke_records=[x for x in cleanup['objects'] if x['name']=='ug-smoke-'+run_id]
            if not smoke_records or not smoke_records[0].get('absent') or \
               smoke_records[0].get('verified_at',float('inf'))-lease['start']>120:
                cleanup['verified']=False;cleanup['smoke_deadline_or_absence_unverified']=True
        cleanup['control_descendants']=controls
        cleanup['verified']=cleanup['verified'] and controls['ECHILD']
        result.update(cleanup=cleanup,failure=failure,
                      maximum_sampled_growth_bytes=max_growth,maximum_sample_interval_seconds=round(max_interval,3),
                      measurement_semantics='sampled growth/floor; no reservation or hard allocation quota')
        if failure:
            result['failure_diagnostics']=failure_diagnostics(root,os.environ.get('RETENTION_TOKEN',''))
            result['candidate_upload_started']=(root/'registry-intent.json').exists()
            if (root/'registry-intent.json').exists():
                result['registry_intent']=json.loads((root/'registry-intent.json').read_bytes())
                result['retention']['outcome']='uncertain after registry copy started; do not retry'
            if (root/'bootstrap-intent.json').exists():
                result['bootstrap_intent']=json.loads((root/'bootstrap-intent.json').read_bytes())
                if not result['candidate_upload_started']:
                    result['retention']={'retained':False,'outcome':'application image not uploaded; inert bootstrap outcome requires checking'}
            if (root/'registry-verified.json').exists():
                result['retention']=json.loads((root/'registry-verified.json').read_bytes())
                result['retention']['bootstrap_cleanup']='uncertain; see failure diagnostics'
        if (root/'local-image-intent.json').exists() and cleanup['verified']:
            try:
                intent=json.loads((root/'local-image-intent.json').read_bytes())
                raw=cleanup_run(['docker','image','ls','-q','--no-trunc',intent['tag']]).decode().strip()
                if raw:
                    if raw!=intent['config_digest']:raise ValueError('task image tag binding changed')
                    cleanup_run(['docker','image','rm','--no-prune',intent['tag']])
                    if cleanup_run(['docker','image','ls','-q',intent['tag']]).strip():raise ValueError('task tag absence unproven')
            except Exception as e:result['local_image_cleanup_error']=str(e)[:200];cleanup['verified']=False
        if cleanup['verified']:
            try:cleanup.update(clean_owned_files(root))
            except Exception as e:cleanup['verified']=False;cleanup['scratch_error']=str(e)[:200]
        result['seconds']=round(time.monotonic()-start,3)
        success=result['completed'] and not failure and cleanup['verified'] and result['seconds']<1190 \
                and (not retain or result['retention'].get('retained') is True)
        result['success']=success
        guard.bounded_json(root/'receipt.json',result)
        summary={k:result.get(k) for k in ['source','tree','success','completed','failure','failure_diagnostics',
                    'seconds','retention','candidate_upload_started','registry_intent','bootstrap_intent','cleanup',
                    'source_export','build_metadata_sha256','resolved_builder_image_id',
                    'kernel_cgroup','smoke','smoke_seconds','independent_smoke_absence_seconds',
                    'sampled_smoke_scratch','graceful_exit_code',
                    'maximum_sampled_growth_bytes','maximum_sample_interval_seconds']}
        if result.get('image'):
            image=result['image'];provenance=image['provenance_predicate']
            summary['image']={k:image[k] for k in ['archive_sha256','archive_bytes','platform',
                'platform_manifest_digest','config_digest','result_root_digests']}
            summary['image']['provenance_sha256']=hashlib.sha256(
                json.dumps(provenance,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            summary['image']['resolved_materials']=provenance.get('materials',[])
        summary['receipt_sha256']=guard.digest(root/'receipt.json')
        summary['receipt_bytes']=(root/'receipt.json').stat().st_size
        text=json.dumps(summary,sort_keys=True,indent=2)+'\n'
        if len(text.encode())>65536:raise ValueError('public summary limit')
        print(text)
        with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as f:f.write('```json\n'+text+'```\n')
        if time.monotonic()-start>=1200:raise RuntimeError('final evidence exceeded total deadline')
    return 0 if success else 1


if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='once':raise SystemExit(owner(Path(sys.argv[2]),sys.argv[3]=='retain-private'))
    root,source=map(Path,sys.argv[2:4]);start=float(sys.argv[4]);run_id,nonce=sys.argv[5:7]
    if mode=='workload':
        guard.bounded_json(root/'workload-result.json',workload(root,source,start,run_id,nonce))
    elif mode=='publish':
        guard.bounded_json(root/'retention-result.json',publish_existing_private(root,start,run_id,os.environ['RETENTION_TOKEN']))
    else:raise SystemExit('unknown fixed operation')
