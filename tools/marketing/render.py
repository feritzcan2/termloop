#!/usr/bin/env python3
"""Render real desktop captures and archived footage into captioned feature demos."""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CAPTURES = Path(os.environ.get('TERMLOOP_MARKETING_CAPTURES', '/tmp/termloop-marketing-captures-20260908'))
OUTPUT = ROOT / 'landing/assets/videos/tour'
WIDTH, HEIGHT, STAGE = 1600, 1040, 900
FONT = os.environ.get('TERMLOOP_MARKETING_FONT', '/System/Library/Fonts/Supplemental/Arial.ttf')

def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)

def duration(path):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(path)]))

def compose(source, feature, step):
    with Image.open(source) as image:
        image = image.convert('RGB')
        scale = min(WIDTH/image.width, STAGE/image.height)
        image = image.resize((round(image.width*scale), round(image.height*scale)), Image.Resampling.LANCZOS)
        canvas = Image.new('RGB', (WIDTH, HEIGHT), '#080d15')
        canvas.paste(image, ((WIDTH-image.width)//2, (STAGE-image.height)//2))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, STAGE, WIDTH, HEIGHT), fill='#121c29')
    draw.rectangle((0, STAGE, WIDTH*(step+1)//3, STAGE+3), fill='#f0b860')
    small = ImageFont.truetype(FONT, 24)
    body = ImageFont.truetype(FONT, 30)
    draw.text((38, 922), f'{step+1:02} / 03   {feature["label"].upper()}', font=small, fill='#f0b860')
    draw.text((1400, 922), 'TERMLOOP', font=small, fill='#899bb3')
    lines = textwrap.wrap(feature['steps'][step], width=92)
    if len(lines) > 2: raise ValueError(f'Caption too long: {feature["id"]}')
    for i, line in enumerate(lines):
        draw.text((38, 963+i*35), line, font=body, fill='#f4f6fa')
    return canvas

def inputs(feature, workspace):
    frames = []
    if feature['legacy']:
        source = ROOT / 'landing' / feature['source']
        run('ffmpeg', '-v', 'error', '-y', '-i', str(source), '-vf', 'fps=8', str(workspace/'source-%05d.png'))
        frames = [(p, 1/8) for p in sorted(workspace.glob('source-*.png'))]
    else:
        for name in feature['captures']:
            folder = CAPTURES/name
            times = json.loads((folder/'timing.json').read_text())
            for i, stamp in enumerate(times):
                elapsed = (times[i+1]-stamp)/1000 if i+1 < len(times) else .25
                # Remove idle capture gaps; keep all observed frames in order.
                frames.append((folder/f'{i:05}.png', min(.65, max(.04, elapsed))))
    if not frames: raise ValueError(f'Empty source: {feature["id"]}')
    return frames

def render(feature, webm=True):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='termloop-tour-') as temporary:
        workspace = Path(temporary)
        frames = inputs(feature, workspace)
        source_duration = sum(seconds for _, seconds in frames)
        total = round(max(18, min(26, source_duration*1.25+6)), 2)
        result = CAPTURES/(feature.get('result', '')+'.png') if not feature['legacy'] else frames[-1][0]
        if not result.is_file(): raise FileNotFoundError(result)
        # A brief orientation, deliberate action pacing, then an explicit result hold.
        action_duration = total-6
        timeline = [(frames[0][0], 1.5)] + [(p, seconds/source_duration*action_duration) for p, seconds in frames] + [(result, 4.5)]
        elapsed = 0.0
        entries = []
        sample_paths = []
        for source, seconds in timeline:
            remaining = seconds
            while remaining > 1e-7:
                step = min(2, int((elapsed+1e-6)/(total/3)))
                until_boundary = (step+1)*total/3-elapsed if step < 2 else remaining
                part = min(remaining, max(1e-7, until_boundary))
                out = workspace/f'frame-{len(entries):05}.png'
                compose(source, feature, step).save(out)
                entries.append((out, part))
                sample_paths.append((elapsed, out))
                elapsed += part
                remaining -= part
        concat = workspace/'timeline.txt'
        concat.write_text(''.join(f"file '{p}'\nduration {seconds:.6f}\n" for p, seconds in entries)+f"file '{entries[-1][0]}'\n")
        target = OUTPUT/feature['id']
        run('ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(concat), '-t', str(total), '-vf', 'fps=24,format=yuv420p', '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-movflags', '+faststart', '-an', str(target.with_suffix('.mp4')))
        if webm:
            run('ffmpeg', '-v', 'error', '-y', '-i', str(target.with_suffix('.mp4')), '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-row-mt', '1', '-cpu-used', '4', '-an', str(target.with_suffix('.webm')))
        # Posters show the completed state; they also work with autoplay disabled.
        compose(result, feature, 2).save(target.with_suffix('.jpg'), quality=86)
        def stamp(seconds):
            ms=round(seconds*1000)
            return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}.{ms%1000:03}'
        target.with_suffix('.vtt').write_text('WEBVTT\n\n'+''.join(f'{i+1}\n{stamp(i*total/3)} --> {stamp((i+1)*total/3)}\n{text}\n\n' for i,text in enumerate(feature['steps'])).rstrip()+'\n')
        qa = Path(os.environ.get('TERMLOOP_MARKETING_QA', '/tmp/termloop-marketing-render-qa-20260908'))
        qa.mkdir(parents=True, exist_ok=True)
        contact = Image.new('RGB', (1200, 286), '#10151e')
        for i, at in enumerate([total*.12, total*.5, total*.88]):
            _, sample = min(sample_paths, key=lambda entry:abs(entry[0]-at))
            image=Image.open(sample); image.thumbnail((400,260));contact.paste(image,(i*400,24))
        ImageDraw.Draw(contact).text((8,5), f'{feature["id"]} / {total:.1f}s / start - middle - end', fill='white')
        contact.save(qa/f'{feature["id"]}.jpg', quality=85)
        report = {'id':feature['id'],'duration':duration(target.with_suffix('.mp4')),'sourceSeconds':round(source_duration,3),'size':target.with_suffix('.mp4').stat().st_size,'sha256':hashlib.sha256(target.with_suffix('.mp4').read_bytes()).hexdigest(),'width':WIDTH,'height':HEIGHT,'fps':24,'captionSteps':3,'legacy':feature['legacy']}
        target.with_suffix('.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report), flush=True)

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--only', nargs='*')
    parser.add_argument('--mp4-only', action='store_true')
    args=parser.parse_args()
    for feature in json.loads((ROOT/'tools/marketing/catalog.json').read_text()):
        if args.only and feature['id'] not in args.only: continue
        render(feature, webm=not args.mp4_only)
