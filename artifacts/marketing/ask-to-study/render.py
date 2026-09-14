#!/usr/bin/env python3
"""Retiming-only Ask To draft. Keep the entire source in chronological order."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parent)
args = parser.parse_args()
source = args.source.resolve()
out = args.output_dir.resolve()
out.mkdir(parents=True, exist_ok=True)
probe = json.loads(subprocess.check_output([
    'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(source)
]))
video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
duration = float(probe['format']['duration'])
assert video['width'] == 1920 and video['height'] == 1080
assert 151 < duration < 153, 'This timing map belongs to the preserved 1080p take.'

# (source end in seconds, speed). Every source instant remains in the time map.
# Idle stretches accelerate; menus, the helper relationship and answer stay readable.
runs = [(16,64),(20,5),(23,24),(28,3),(29.8,1),(64.2,56),(65.4,1),
        (111,36),(114,10),(117,1),(140,24),(145,1),(duration,32)]
spans = []
start = 0.0
for end, speed in runs:
    assert end > start and speed >= 1
    spans.append({'start': start, 'end': end, 'speed': speed})
    start = end
assert spans[0]['start'] == 0 and spans[-1]['end'] == duration
assert all(a['end'] == b['start'] for a,b in zip(spans,spans[1:]))

# Smooth inverse-speed changes over small source-time ramps. Integrating these
# curves gives a continuous, strictly increasing time map, with no jump cuts.
pieces = []
cursor = 0.0
previous_rate = 1.0 / spans[0]['speed']
for i in range(len(spans)-1):
    left,right = spans[i],spans[i+1]
    boundary = left['end']
    half = min(.6,(left['end']-left['start'])/4,(right['end']-right['start'])/4)
    if boundary-half > cursor:
        pieces.append((cursor,boundary-half,previous_rate,previous_rate))
    next_rate = 1.0/right['speed']
    pieces.append((boundary-half,boundary+half,previous_rate,next_rate))
    cursor = boundary+half
    previous_rate = next_rate
pieces.append((cursor,duration,previous_rate,previous_rate))

def mapped(t):
    result = 0.0
    for a,b,r0,r1 in pieces:
        u = max(0.0,min(1.0,(t-a)/(b-a)))
        result += (b-a)*(r0*u+(r1-r0)*(u**3-.5*u**4))
    return result

terms = []
for a,b,r0,r1 in pieces:
    length = b-a
    u = f'clip((T-{a:.9f})/{length:.9f},0,1)'
    if r0 == r1:
        terms.append(f'clip(T-{a:.9f},0,{length:.9f})*{r0:.12f}')
    else:
        terms.append(f'{length:.9f}*({r0:.12f}*({u})+{r1-r0:.12f}*(pow({u},3)-0.5*pow({u},4)))')
warp = '+'.join(terms)
filters = [f"[0:v]setpts=PTS-STARTPTS,setpts='({warp})/TB',fps=30,format=yuv420p[retimed]"]

# Brief click ripples on the three main actions, with the soft glow retained.
# These mark clicks only; terminal text and the camera remain unchanged.
clicks = [
    {'sourceTime':23.3,'x':230,'y':263,'label':'Open Session menu'},
    {'sourceTime':28.25,'x':320,'y':478,'label':'Agents menu'},
    {'sourceTime':64.4,'x':500,'y':533,'label':'Ask To / Codex'},
]
previous = 'retimed'
for i,click in enumerate(clicks):
    t = mapped(click['sourceTime'])
    click['outputTime'] = round(t,6)
    distance_squared = '(X-64)*(X-64)+(Y-64)*(Y-64)'
    ring = f'if(lt(abs(sqrt({distance_squared})-(8+20*T/0.45)),2.2),210,0)'
    core = f'if(lt(T,0.1)*lt({distance_squared},16),170,0)'
    glow = f'14*exp(-({distance_squared})/(2*24*24))'
    filters.append(
        f"color=c=black:s=128x128:r=30:d=0.45,format=rgba,"
        f"geq=r='172':g='239':b='227':a='max({glow},{ring}+{core})',"
        f"fade=t=in:st=0:d=0.033333:alpha=1,fade=t=out:st=0.1:d=0.35:alpha=1,"
        f"setpts=PTS-STARTPTS+{max(0,t-.04):.9f}/TB[click{i}]"
    )
    filters.append(f'[{previous}][click{i}]overlay={click["x"]-64}:{click["y"]-64}:eof_action=pass:repeatlast=0[v{i}]')
    previous = f'v{i}'
filters.append(f'[{previous}]format=yuv420p[final]')
filter_file = out/'retime.ffmpeg'
filter_file.write_text(';\n'.join(filters)+'\n')
output = out/'ask-to-preview.mp4'
rendering = out/'.ask-to-preview.rendering.mp4'
subprocess.run([
    'ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(source),
    '-filter_complex_script',str(filter_file),'-map','[final]','-an',
    '-c:v','libx264','-preset','slow','-crf','17','-r','30','-fps_mode','cfr',
    '-movflags','+faststart',str(rendering)
],check=True)
actual = json.loads(subprocess.check_output([
    'ffprobe','-v','error','-show_streams','-show_format','-of','json',str(rendering)
]))
rendering.replace(output)
output_video = actual['streams'][0]
manifest = {
    'draft':True,'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
    'sourceResolution':[1920,1080],'sourceDurationSeconds':duration,
    'output':output.name,'width':output_video['width'],'height':output_video['height'],
    'fps':30,'frames':int(output_video['nb_frames']),
    'durationSeconds':float(actual['format']['duration']),'audio':False,
    'editing':'Full source, chronological and uncut. Continuous speed ramps, with brief click ripples and soft glows on menu actions. No crops, zooms, captions or terminal highlighting.',
    'sourceCoverage':[0,duration],'speedMap':spans,'clicks':clicks,
    'firstClickSeconds':mapped(23.3),
    'menuDismissalToActionSeconds':mapped(65)-mapped(30.5),
    'actionToVisibleHelperSeconds':mapped(114)-mapped(65),
    'chapters':{'question':mapped(16),'askTo':mapped(23),'helper':mapped(114),'answer':mapped(140)},
}
(out/'edit.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'output':str(output),'duration':manifest['durationSeconds'],'frames':manifest['frames'],'firstClickSeconds':manifest['firstClickSeconds'],'menuDismissalToActionSeconds':manifest['menuDismissalToActionSeconds'],'actionToVisibleHelperSeconds':manifest['actionToVisibleHelperSeconds'],'clicks':clicks},indent=2))
