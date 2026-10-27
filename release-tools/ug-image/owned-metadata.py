"""Read-only accounting of one nonce-bound container's Docker metadata.

The future ephemeral runner invokes this sealed helper via existing sudo only
for read access. It changes no privilege/settings/ownership and prints no data.
"""
import json
import os
from pathlib import Path
import re
import stat
import sys


def measure(docker_root,identity,owner):
    if not re.fullmatch('[0-9a-f]{64}',identity) or not re.fullmatch('[0-9a-f]{32}',owner):
        raise ValueError('invalid owned identity')
    root=docker_root/'containers'/identity
    if root.is_symlink() or not root.is_dir():raise ValueError('metadata root mismatch')
    path=root/'config.v2.json'
    if path.is_symlink() or path.stat().st_size>512*1024:raise ValueError('metadata binding cap')
    config=json.loads(path.read_bytes())
    if config.get('ID')!=identity or 'UG_IMAGE_OWNER='+owner not in config.get('Config',{}).get('Env',[]):
        raise ValueError('metadata owner binding mismatch')
    total=logs=entries=0
    for base,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            p=Path(base)/name;s=p.lstat();entries+=1
            if entries>1000 or not(stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
                raise ValueError('metadata graph/type/count limit')
            size=max(s.st_size,s.st_blocks*512);total+=size
            if p.relative_to(root).parts[0]=='local-logs':logs+=size
    return {'total_bytes':total,'log_bytes':logs,'ancillary_bytes':total-logs,'entries':entries}


if __name__=='__main__':
    if len(sys.argv)!=3:raise SystemExit('fixed identity/owner required')
    print(json.dumps(measure(Path('/var/lib/docker'),*sys.argv[1:3])))
