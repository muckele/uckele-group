import importlib.util,json,os,signal,subprocess,sys
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
source=Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('handoff_review',source)
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
original_popen=subprocess.Popen
original_killpg=os.killpg
results=[]
def interrupted(_signum,_frame):
    raise h.Hold('synthetic actual SIGTERM delivery')
old_handler=signal.signal(signal.SIGTERM,interrupted)
try:
    for mode in ('SIGTERM-after-spawn-before-bookkeeping','SIGTERM-during-settlement'):
        owned=[]
        def launch(*args,**kwargs):
            child=original_popen(*args,**kwargs);owned.append(child)
            if mode=='SIGTERM-after-spawn-before-bookkeeping':
                os.kill(os.getpid(),signal.SIGTERM)
            return child
        def interrupt_settlement(pgid,number):
            if number==signal.SIGTERM:
                os.kill(os.getpid(),signal.SIGTERM)
            return original_killpg(pgid,number)
        held=False
        try:
            with patch.object(h.subprocess,'Popen',side_effect=launch):
                if mode=='SIGTERM-during-settlement':
                    with patch.object(h.os,'killpg',side_effect=interrupt_settlement):
                        h.run_command([sys.executable,'-B','-c','import time;time.sleep(30)'],{'PATH':'/usr/bin:/bin','HOME':'/tmp'},0.03)
                else:
                    h.run_command([sys.executable,'-B','-c','import time;time.sleep(30)'],{'PATH':'/usr/bin:/bin','HOME':'/tmp'},0.03)
        except h.Hold:
            held=True
        child=owned[0]
        try:
            running=child.poll() is None
            try:original_killpg(child.pid,0);group_present=True
            except ProcessLookupError:group_present=False
            results.append({'mode':mode,'held':held,'ownedChildStillRunning':running,'ownedGroupStillPresent':group_present})
        finally:
            try:original_killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            child.wait(timeout=3)
            for stream in (child.stdout,child.stderr):
                if stream:stream.close()
    ordinary=h.run_command([sys.executable,'-B','-c',"import json,signal;print(json.dumps({'blocked':sorted(int(n) for n in signal.pthread_sigmask(signal.SIG_BLOCK,set()))}))"],{'PATH':'/usr/bin:/bin','HOME':'/tmp'},3)
finally:
    signal.signal(signal.SIGTERM,old_handler)
print(json.dumps({'source':str(source),'syntheticOnly':True,'actualSIGTERMDelivered':True,'results':results,'ordinaryChildMask':ordinary},indent=2))
