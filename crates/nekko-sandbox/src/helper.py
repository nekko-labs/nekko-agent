
import os,sys,json,base64,hashlib,stat,fnmatch,re
q=json.loads(sys.argv[1]); root='/workspace'; limit=q['limits']; op=q['op']
def safe(p):
 if not isinstance(p,str) or not p or p.startswith('/') or '\\' in p or ':' in p or any(x in ('','.', '..','.git','node_modules') or x=='.env' or x.startswith('.env.') for x in p.split('/')): raise Exception('unsafe path')
 full=root+'/'+p; current=root
 for part in p.split('/'):
  current+='/'+part
  if os.path.lexists(current):
   s=os.lstat(current)
   if stat.S_ISLNK(s.st_mode) or not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)) or (stat.S_ISREG(s.st_mode) and s.st_nlink!=1): raise Exception('link/special file')
 return full
def read(p):
 f=os.open(safe(p),os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(f)
  if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>limit['bytes']: raise Exception('invalid file')
  with os.fdopen(f,'rb',closefd=False) as h: return h.read(limit['bytes']+1)
 finally: os.close(f)
def snapshot():
 out=[]; size=0
 for directory,dirs,files in os.walk(root,followlinks=False):
  for name in dirs+files: safe(os.path.relpath(directory+'/'+name,root))
  for name in files:
   p=os.path.relpath(directory+'/'+name,root); b=read(p); size+=len(b)
   if size>limit['bytes'] or len(out)>=limit['files']: raise Exception('workspace limit exceeded')
   out.append({'path':p,'base64':base64.b64encode(b).decode(),'hash':hashlib.sha256(b).hexdigest()})
 return out
if op=='snapshot': result=snapshot()
elif op in ('write','append'):
 p=q['path']; b=base64.b64decode(q['base64'],validate=True)
 if len(b)>limit['bytes']: raise Exception('file too large')
 full=safe(p); os.makedirs(os.path.dirname(full),exist_ok=True); safe(p)
 f=os.open(full,os.O_WRONLY|os.O_CREAT|(os.O_APPEND if op=='append' else os.O_TRUNC)|os.O_NOFOLLOW,0o600)
 try: os.write(f,b)
 finally: os.close(f)
 result={'written':p}
elif op=='read': result={'base64':base64.b64encode(read(q['path'])).decode()}
elif op=='edit':
 p=q['path']; text=read(p).decode(); old=q['old_string']
 if not old or text.count(old)!=1: raise Exception('edit requires one exact match')
 b=text.replace(old,q['new_string']).encode()
 if len(b)>limit['bytes']: raise Exception('file too large')
 f=os.open(safe(p),os.O_WRONLY|os.O_TRUNC|os.O_NOFOLLOW)
 try: os.write(f,b)
 finally: os.close(f)
 result={'edited':p}
elif op in ('list','glob','grep'):
 entries=snapshot(); prefix=q.get('path',''); result=[]
 for e in entries:
  p=e['path']
  if prefix and not (p==prefix or p.startswith(prefix+'/')): continue
  if op=='list': result.append(p)
  elif op=='glob' and fnmatch.fnmatchcase(p,q['pattern']): result.append(p)
  elif op=='grep':
   for i,line in enumerate(base64.b64decode(e['base64']).decode('utf8',errors='replace').splitlines(),1):
    if re.search(q['pattern'],line): result.append({'path':p,'line':i,'text':line})
else: raise Exception('unsupported operation')
print(json.dumps(result,separators=(',',':')))
