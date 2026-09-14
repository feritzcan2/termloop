"""Render short, explicitly cut close-ups from checksum-pinned real footage."""
import hashlib
import json
import math
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path


def validate_shots(edit, durations, crop_filter):
    fps = edit['fps']
    if fps not in (15, 20, 30):
        raise ValueError('Unsupported delivery frame rate')
    elapsed = 0
    for shot in edit['shots']:
        index = shot['source']
        if type(index) is not int or not 0 <= index < len(durations):
            raise ValueError('Unknown shot source')
        start, end, duration = (shot[k] for k in ('start', 'end', 'duration'))
        if not all(math.isfinite(n) for n in (start, end, duration)) or not 0 <= start < end <= durations[index]+.001:
            raise ValueError('Shot must stay within its recording')
        if duration <= 0 or abs(duration*fps-round(duration*fps)) > 1e-6:
            raise ValueError('Shot duration must end on a frame boundary')
        crop_filter(shot['crop'])
        elapsed += duration
    anchors = edit['stepsAt']
    if len(anchors) != 3 or anchors[0] != 0 or not all(a < b for a, b in zip(anchors, anchors[1:]+[elapsed])):
        raise ValueError('Three captions must follow the edit')
    if not 0 <= edit['posterAt'] < elapsed:
        raise ValueError('Poster must be inside the edit')
    return elapsed


def render_shots(feature, edit, recordings, output, root, probe, stamp, crop_filter):
    sources, reports = [], []
    for spec in edit['sources']:
        if spec['root'] not in ('landing', 'recordings'):
            raise ValueError('Unknown source root')
        directory = root/'landing' if spec['root'] == 'landing' else recordings
        if directory is None:
            raise ValueError('Raw recordings directory required')
        source = directory/spec['source']
        if hashlib.sha256(source.read_bytes()).hexdigest() != spec['sourceSha256']:
            raise ValueError('Source checksum differs from the selected recording')
        info = probe(source)
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        fps = float(Fraction(video['avg_frame_rate']))
        if (video['width'], video['height']) != (1920, 1080) or abs(fps-edit['fps']) >= .1:
            raise ValueError('Source dimensions or recorded frame rate changed')
        sources.append(source)
        reports.append({**spec, 'duration': float(info['format']['duration']), 'fps': fps})
    planned = validate_shots(edit, [s['duration'] for s in reports], crop_filter)
    if len(feature['steps']) != 3:
        raise ValueError('Three written steps are required')
    output.mkdir(parents=True, exist_ok=True)
    target = output/feature['id']
    with tempfile.TemporaryDirectory(prefix='termloop-closeup-') as folder:
        folder = Path(folder)
        for i, shot in enumerate(edit['shots']):
            duration = shot['duration']
            speed = (shot['end']-shot['start'])/duration
            # Explicit frame count avoids rounding accumulating across cuts.
            filters = (f"setpts=(PTS-STARTPTS)/{speed:.12f},"+crop_filter(shot['crop'])+
                       f",fps={edit['fps']},tpad=stop_mode=clone:stop_duration=0.1,format=yuv420p")
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(shot['start']),
                '-t', str(shot['end']-shot['start']), '-i', str(sources[shot['source']]),
                '-vf', filters, '-frames:v', str(round(duration*edit['fps'])), '-an',
                '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-threads', '4',
                '-r', str(edit['fps']), '-fps_mode', 'cfr', str(folder/f'{i}.mp4')], check=True)
        (folder/'list.txt').write_text(''.join(f"file '{i}.mp4'\n" for i in range(len(edit['shots']))))
        staged = folder/'joined.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', str(folder/'list.txt'),
            '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', str(staged)], check=True)
        info = probe(staged)
        duration = float(info['format']['duration'])
        if abs(duration-planned) > .001 or int(info['streams'][0]['nb_frames']) != round(planned*edit['fps']):
            raise ValueError('Rendered frame count differs from the edit')
        target.with_suffix('.mp4').write_bytes(staged.read_bytes())
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(edit['posterAt']), '-i', str(target.with_suffix('.mp4')),
        '-frames:v', '1', '-q:v', '2', '-update', '1', str(target.with_suffix('.jpg'))], check=True)
    anchors = edit['stepsAt']
    target.with_suffix('.vtt').write_text('WEBVTT\n\n'+''.join(
        f'{i+1}\n{stamp(a)} --> {stamp(b)} line:5%\n{text}\n\n'
        for i, (a, b, text) in enumerate(zip(anchors, anchors[1:]+[duration], feature['steps']))).rstrip()+'\n')
    report = {'id': feature['id'], 'duration': duration, 'width': 1920, 'height': 1080,
        'fps': edit['fps'], 'frames': int(info['streams'][0]['nb_frames']), 'audio': False,
        'captureKind': 'edited-video', 'sources': reports, 'shots': edit['shots'],
        'sha256': hashlib.sha256(target.with_suffix('.mp4').read_bytes()).hexdigest(),
        'editing': 'Selected moments from real recordings. Hard cuts omit waits; fixed close-ups enlarge the action. Source frame rate retained; no invented UI or terminal content.'}
    target.with_suffix('.json').write_text(json.dumps(report, indent=2)+'\n')
    print(f"{feature['id']}: {duration:.2f}s, {edit['fps']} fps, {len(edit['shots'])} close-ups", flush=True)
