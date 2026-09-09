#!/usr/bin/env python3
"""Caption continuous video recordings without discarding or stretching motion frames."""
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import textwrap
from fractions import Fraction
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
RECORDINGS = Path(os.environ.get('TERMLOOP_MARKETING_RECORDINGS', '/tmp/termloop-marketing-native-20260909'))
OUTPUT = ROOT / 'landing/assets/videos/tour'
WIDTH, HEIGHT, STAGE, FPS = 1920, 1248, 1080, 30
FONT = os.environ.get('TERMLOOP_MARKETING_FONT', '/System/Library/Fonts/Supplemental/Arial.ttf')


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format', '-of', 'json', str(path)]))


def caption(feature, step):
    panel = Image.new('RGB', (WIDTH, HEIGHT-STAGE), '#121c29')
    draw = ImageDraw.Draw(panel)
    draw.rectangle((0, 0, WIDTH*(step+1)//3, 3), fill='#f0b860')
    small = ImageFont.truetype(FONT, 29)
    body = ImageFont.truetype(FONT, 36)
    draw.text((46, 26), f'{step+1:02} / 03   {feature["label"].upper()}', font=small, fill='#f0b860')
    draw.text((1680, 26), 'TERMLOOP', font=small, fill='#899bb3')
    lines = textwrap.wrap(feature['steps'][step], width=92)
    if len(lines) > 2:
        raise ValueError(f'Caption too long: {feature["id"]}')
    for i, line in enumerate(lines):
        draw.text((46, 76+i*42), line, font=body, fill='#f4f6fa')
    return panel


def stamp(seconds):
    ms = round(seconds*1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}.{ms%1000:03}'


def render(feature, webm=True):
    source = ROOT/'landing'/feature['source'] if feature['legacy'] else RECORDINGS/f'{feature["id"]}.mp4'
    if not source.is_file():
        raise FileNotFoundError(f'{source}: a continuous video recording is required; PNG frame sequences are not accepted')
    info = probe(source)
    source_duration = float(info['format']['duration'])
    source_fps = float(Fraction(info['streams'][0]['avg_frame_rate']))
    if source_fps < (15 if feature['legacy'] else 29):
        raise ValueError(f'{source}: capture rate {source_fps:.2f} FPS is too low; record again')
    if source_fps > FPS + .1:
        raise ValueError(f'{source}: capture exceeds {FPS} FPS; do not silently discard motion frames')
    # Motion always runs at its recorded speed. Only the first/last stills are held.
    orientation = .75
    result_hold = max(1.75, 9-source_duration-orientation) if feature['legacy'] else 1.75
    total = source_duration+orientation+result_hold
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='termloop-tour-') as temporary:
        workspace = Path(temporary)
        inputs = ['-i', str(source)]
        for step in range(3):
            panel = workspace/f'caption-{step}.png'
            caption(feature, step).save(panel)
            inputs += ['-loop', '1', '-framerate', '1', '-i', str(panel)]
        filters = [f'[0:v]fps={FPS},scale={WIDTH}:{STAGE}:force_original_aspect_ratio=decrease:flags=lanczos,pad={WIDTH}:{HEIGHT}:(ow-iw)/2:({STAGE}-ih)/2:color=0x080d15,setsar=1,tpad=start_mode=clone:start_duration={orientation}:stop_mode=clone:stop_duration={result_hold}[base]']
        for step in range(3):
            previous = 'base' if step == 0 else f'captioned{step-1}'
            filters.append(f"[{previous}][{step+1}:v]overlay=0:{STAGE}:enable='gte(t,{step*total/3})*lt(t,{(step+1)*total/3})'[captioned{step}]")
        target = OUTPUT/feature['id']
        run('ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(filters), '-map', '[captioned2]', '-t', str(total), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', str(target.with_suffix('.mp4')))
        if webm:
            run('ffmpeg', '-v', 'error', '-y', '-i', str(target.with_suffix('.mp4')), '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '28', '-row-mt', '1', '-cpu-used', '4', '-an', str(target.with_suffix('.webm')))
        run('ffmpeg', '-v', 'error', '-y', '-ss', str(total-.25), '-i', str(target.with_suffix('.mp4')), '-frames:v', '1', '-q:v', '2', '-update', '1', str(target.with_suffix('.jpg')))
        target.with_suffix('.vtt').write_text('WEBVTT\n\n'+''.join(f'{i+1}\n{stamp(i*total/3)} --> {stamp((i+1)*total/3)}\n{text}\n\n' for i, text in enumerate(feature['steps'])).rstrip()+'\n')
        qa = Path(os.environ.get('TERMLOOP_MARKETING_QA', '/tmp/termloop-marketing-native-qa-20260909'))
        qa.mkdir(parents=True, exist_ok=True)
        run('ffmpeg', '-v', 'error', '-y', '-i', str(target.with_suffix('.mp4')), '-vf', f'fps={3/total},scale=400:260,tile=3x1', '-frames:v', '1', '-update', '1', str(qa/f'{feature["id"]}.jpg'))
        report = {'id': feature['id'], 'duration': float(probe(target.with_suffix('.mp4'))['format']['duration']), 'sourceSeconds': source_duration, 'sourceFps': source_fps, 'motionSpeed': 1, 'size': target.with_suffix('.mp4').stat().st_size, 'sha256': hashlib.sha256(target.with_suffix('.mp4').read_bytes()).hexdigest(), 'width': WIDTH, 'height': HEIGHT, 'fps': FPS, 'captionSteps': 3, 'legacy': feature['legacy'], 'captureKind': 'continuous-video'}
        target.with_suffix('.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', nargs='*')
    parser.add_argument('--legacy-only', action='store_true')
    parser.add_argument('--mp4-only', action='store_true')
    args = parser.parse_args()
    for feature in json.loads((ROOT/'tools/marketing/catalog.json').read_text()):
        if args.only and feature['id'] not in args.only:
            continue
        if args.legacy_only and not feature['legacy']:
            continue
        render(feature, webm=not args.mp4_only)
