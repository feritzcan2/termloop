#!/usr/bin/env python3
"""Render continuous 1080p demos with smooth time compression and click ripples."""
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'landing/assets/videos/tour'
FPS = 30


def probe(path):
    return json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))


def validate_source(source, expected_hash):
    if not source.is_file():
        raise FileNotFoundError(f'{source}: a continuous video recording is required')
    info = probe(source)
    video = next(s for s in info['streams'] if s['codec_type'] == 'video')
    rate = float(Fraction(video['avg_frame_rate']))
    if rate < 29.9:
        raise ValueError('Capture rate is too low; record at 30 fps')
    if rate > 30.1:
        raise ValueError('Capture exceeds 30 fps; do not silently discard motion frames')
    if (video['width'], video['height']) != (1920, 1080):
        raise ValueError('A native 1920 × 1080 recording is required; do not upscale')
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != expected_hash:
        raise ValueError('Source checksum differs from the reviewed take')
    return float(info['format']['duration']), rate


class TimeMap:
    """Integrate smooth inverse-speed ramps, keeping source time strictly ordered."""
    def __init__(self, duration, runs):
        self.spans = []
        start = 0.0
        for end, speed in runs:
            end = duration if end is None else float(end)
            if not start < end <= duration or not 1 <= speed <= 128:
                raise ValueError('Speed map must increase continuously within the source')
            self.spans.append({'start': start, 'end': end, 'speed': speed})
            start = end
        if not self.spans or abs(start - duration) > 1e-6:
            raise ValueError('Speed map must cover the entire selected recording')
        self.pieces = []
        cursor = 0.0
        previous = 1 / self.spans[0]['speed']
        for left, right in zip(self.spans, self.spans[1:]):
            boundary = left['end']
            half = min(.6, (left['end']-left['start'])/4, (right['end']-right['start'])/4)
            if boundary-half > cursor:
                self.pieces.append((cursor, boundary-half, previous, previous))
            following = 1 / right['speed']
            self.pieces.append((boundary-half, boundary+half, previous, following))
            cursor, previous = boundary+half, following
        self.pieces.append((cursor, duration, previous, previous))

    def mapped(self, time):
        result = 0.0
        for a, b, r0, r1 in self.pieces:
            u = max(0.0, min(1.0, (time-a)/(b-a)))
            result += (b-a)*(r0*u+(r1-r0)*(u**3-.5*u**4))
        return result

    def expression(self):
        terms = []
        for a, b, r0, r1 in self.pieces:
            length = b-a
            u = f'clip((T-{a:.9f})/{length:.9f},0,1)'
            if r0 == r1:
                terms.append(f'clip(T-{a:.9f},0,{length:.9f})*{r0:.12f}')
            else:
                terms.append(f'{length:.9f}*({r0:.12f}*({u})+{r1-r0:.12f}*(pow({u},3)-0.5*pow({u},4)))')
        return '+'.join(terms)


def filters_for(timing, clicks, source_end, remove_capture_cursor=False):
    # Remove the recorder's stationary coordinate cursor from an empty corner.
    cleanup = 'delogo=x=1558:y=940:w=66:h=47:show=0,' if remove_capture_cursor else ''
    filters = [f"[0:v]{cleanup}trim=end={source_end},setpts=PTS-STARTPTS,setpts='({timing.expression()})/TB',fps={FPS},format=yuv420p[retimed]"]
    previous = 'retimed'
    for i, click in enumerate(clicks):
        if not 0 <= click['sourceTime'] < source_end:
            raise ValueError('Click falls outside the recording')
        if not 0 <= click['x'] <= 1920 or not 0 <= click['y'] <= 1080:
            raise ValueError('Click falls outside the window')
        time = timing.mapped(click['sourceTime'])
        click['outputTime'] = round(time, 6)
        distance = '(X-64)*(X-64)+(Y-64)*(Y-64)'
        ring = f'if(lt(abs(sqrt({distance})-(8+20*T/0.45)),2.2),210,0)'
        core = f'if(lt(T,0.1)*lt({distance},16),170,0)'
        glow = f'14*exp(-({distance})/(2*24*24))'
        filters.append(
            f"color=c=black:s=128x128:r={FPS}:d=0.45,format=rgba,"
            f"geq=r='172':g='239':b='227':a='max({glow},{ring}+{core})',"
            f"fade=t=in:st=0:d=0.033333:alpha=1,fade=t=out:st=0.1:d=0.35:alpha=1,"
            f"setpts=PTS-STARTPTS+{max(0,time-.04):.9f}/TB[click{i}]")
        filters.append(f'[{previous}][click{i}]overlay={click["x"]-64}:{click["y"]-64}:eof_action=pass:repeatlast=0[v{i}]')
        previous = f'v{i}'
    filters.append(f'[{previous}]format=yuv420p[final]')
    return ';\n'.join(filters)+'\n'


def stamp(seconds):
    ms = round(seconds*1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}.{ms%1000:03}'


def restore_archive(feature, edit, output):
    """Keep an explicitly selected earlier edit byte-for-byte, including its FPS."""
    source = ROOT / 'landing' / edit['archiveSource']
    data = source.read_bytes()
    if hashlib.sha256(data).hexdigest() != edit['sourceSha256']:
        raise ValueError('Archive checksum differs from the selected clip')
    info = probe(source)
    video = info['streams'][0]
    rate = float(Fraction(video['avg_frame_rate']))
    if len(info['streams']) != 1 or video['codec_type'] != 'video':
        raise ValueError('Archive must contain only a silent video')
    if (video['width'], video['height']) != (1920, 1080) or rate != edit['sourceFps']:
        raise ValueError('Archive dimensions or frame rate changed')
    duration = float(info['format']['duration'])
    anchors = edit['stepsAt']
    if len(anchors) != len(feature['steps']) or anchors[0] != 0 or any(
            not a < b for a, b in zip(anchors, anchors[1:] + [duration])):
        raise ValueError('Archive captions must follow the recording')
    output.mkdir(parents=True, exist_ok=True)
    target = output / feature['id']
    target.with_suffix('.mp4').write_bytes(data)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(edit['posterAt']),
        '-i', str(source), '-frames:v', '1', '-q:v', '2', '-update', '1',
        str(target.with_suffix('.jpg'))], check=True)
    target.with_suffix('.vtt').write_text(('WEBVTT\n\n' + ''.join(
        f'{i+1}\n{stamp(a)} --> {stamp(b)}\n{text}\n\n'
        for i, (a, b, text) in enumerate(zip(anchors, anchors[1:] + [duration], feature['steps'])))).rstrip()+'\n')
    report = {'id': feature['id'], 'duration': duration, 'width': 1920, 'height': 1080,
        'fps': rate, 'frames': int(video['nb_frames']), 'audio': False,
        'captureKind': 'archive-video', 'source': edit['archiveSource'],
        'sourceSha256': edit['sourceSha256'], 'sourceFps': rate,
        'sourceSeconds': duration, 'sourceCoverage': [0, duration],
        'sha256': edit['sourceSha256'],
        'editing': 'Earlier published edit restored byte-for-byte. Original timing and frame rate retained; no new cuts, retiming or effects.'}
    target.with_suffix('.json').write_text(json.dumps(report, indent=2)+'\n')
    print(f'{feature["id"]}: restored original {duration:.2f}s, {rate:g} fps', flush=True)


def render(feature, edit, recordings, output=OUTPUT):
    if edit.get('archiveSource'):
        return restore_archive(feature, edit, output)
    source = recordings / edit['source']
    source_duration, source_fps = validate_source(source, edit['sourceSha256'])
    end = edit.get('sourceEnd', source_duration)
    if not 0 < end <= source_duration:
        raise ValueError('Invalid source endpoint')
    timing = TimeMap(end, edit['runs'])
    clicks = [dict(c) for c in edit['clicks']]
    if len(edit['stepsAt']) != len(feature['steps']):
        raise ValueError('Each written step needs a source-time anchor')
    anchors = [timing.mapped(t) for t in edit['stepsAt']]
    if anchors != sorted(anchors) or any(t < 0 or t >= end for t in edit['stepsAt']):
        raise ValueError('Step anchors must follow the recording')
    output.mkdir(parents=True, exist_ok=True)
    target = output / feature['id']
    with tempfile.TemporaryDirectory(prefix='termloop-retime-') as temporary:
        graph = Path(temporary)/'retime.ffmpeg'
        graph.write_text(filters_for(timing, clicks, end, edit.get('removeCaptureCursor', False)))
        staged = Path(temporary)/'demo.mp4'
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(source),
            '-filter_complex_script',str(graph),'-map','[final]','-an',
            '-c:v','libx264','-preset','slow','-crf','17','-threads','4',
            '-r',str(FPS),'-fps_mode','cfr','-movflags','+faststart',str(staged)], check=True)
        info = probe(staged)
        duration = float(info['format']['duration'])
        video = info['streams'][0]
        target.with_suffix('.mp4').write_bytes(staged.read_bytes())
    subprocess.run(['ffmpeg','-v','error','-y','-ss',str(timing.mapped(edit['posterAt'])),
        '-i',str(target.with_suffix('.mp4')),'-frames:v','1','-q:v','2','-update','1',
        str(target.with_suffix('.jpg'))], check=True)
    anchors[0] = 0
    ends = anchors[1:] + [duration]
    target.with_suffix('.vtt').write_text('WEBVTT\n\n'+''.join(
        f'{i+1}\n{stamp(a)} --> {stamp(b)}\n{text}\n\n'
        for i,(a,b,text) in enumerate(zip(anchors, ends, feature['steps']))))
    report = {'id':feature['id'], 'duration':duration, 'width':1920, 'height':1080,
        'fps':FPS, 'frames':int(video['nb_frames']), 'audio':False,
        'captureKind':'continuous-video', 'source':edit['source'],
        'recordedAt':edit['recordedAt'], 'recoveredFrom':edit.get('recoveredFrom'),
        'captureCursorRemoved':edit.get('removeCaptureCursor', False),
        'sourceSha256':edit['sourceSha256'], 'sourceSeconds':source_duration,
        'sourceFps':source_fps, 'sourceCoverage':[0,end], 'speedMap':timing.spans,
        'clicks':clicks, 'sha256':hashlib.sha256(target.with_suffix('.mp4').read_bytes()).hexdigest(),
        'editing':'Continuous source interval; smooth speed ramps; click ripples. No interior cuts, camera zoom, added caption panels or terminal highlights.'}
    target.with_suffix('.json').write_text(json.dumps(report,indent=2)+'\n')
    print(f'{feature["id"]}: {duration:.2f}s, 1920×1080, {FPS} fps, {len(clicks)} clicks', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recordings', type=Path, default=os.environ.get('TERMLOOP_MARKETING_RECORDINGS'))
    parser.add_argument('--only', nargs='+')
    args = parser.parse_args()
    catalog = json.loads((ROOT/'tools/marketing/catalog.json').read_text())
    edits = json.loads((ROOT/'tools/marketing/edits.json').read_text())
    selected = [f for f in catalog if not args.only or f['id'] in args.only]
    if args.recordings is None and any(not edits[f['id']].get('archiveSource') for f in selected):
        parser.error('Pass --recordings or set TERMLOOP_MARKETING_RECORDINGS')
    for feature in selected:
        render(feature, edits[feature['id']], Path(args.recordings) if args.recordings else None)


if __name__ == '__main__':
    main()
