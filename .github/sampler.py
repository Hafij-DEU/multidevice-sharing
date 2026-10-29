import os, time, subprocess, sys
def log(*a):
    print(time.strftime('%H:%M:%S', time.gmtime()) + f'.{int(time.time()*1000)%1000:03d}', *a, flush=True)
def mains():
    out = []
    for p in os.listdir('/proc'):
        if not p.isdigit(): continue
        try: cl = open(f'/proc/{p}/cmdline','rb').read().split(b'\0')
        except Exception: continue
        if any(b'main.cjs' in x for x in cl) and not any(x.startswith(b'--type=') for x in cl) and b'electron' in cl[0].lower():
            out.append(int(p))
    return out
def rd(path):
    try: return open(path).read().strip()
    except Exception as e: return f'ERR{e.__class__.__name__}'
st = {}
dumps = {}
log('gdb', subprocess.run(['which','gdb'],capture_output=True,text=True).stdout.strip())
while True:
    for pid in mains():
        stat = rd(f'/proc/{pid}/task/{pid}/stat')
        try:
            f = stat.rsplit(')',1)[1].split(); state=f[0]; cpu=int(f[11])+int(f[12])
        except Exception: continue
        sc = rd(f'/proc/{pid}/task/{pid}/syscall'); wc = rd(f'/proc/{pid}/task/{pid}/wchan')
        prev = st.get(pid)
        now = time.time()
        if prev is None or prev['cpu'] != cpu or prev['sc'] != sc:
            st[pid] = {'cpu':cpu,'sc':sc,'since':now,'busy':0}
            if prev is not None and cpu - prev['cpu'] >= 40: st[pid]['busy']=prev['busy']+1
            else: st[pid]['busy']=0
        dur = now - st[pid]['since']
        log(pid, state, cpu, wc, sc[:60], f'same={dur:.1f}s', f'busy={st[pid]["busy"]}')
        stuck = dur > 2.0 or st[pid]['busy'] >= 4
        if stuck and dumps.get(pid,0) < 6 and now - st[pid].get('dumped',0) > 5:
            st[pid]['dumped'] = now; dumps[pid] = dumps.get(pid,0)+1
            r = subprocess.run(['timeout','20','gdb','-batch','-p',str(pid),'-ex','set pagination off','-ex','info threads','-ex','thread apply all bt 25'],capture_output=True,text=True)
            log('GDB', pid, 'BEGIN'); print(r.stdout[-60000:], r.stderr[-2000:], flush=True); log('GDB', pid, 'END')
    time.sleep(0.5)
