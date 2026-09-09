#!/usr/bin/env python3
"""Render the README's eight looping, zoomed previews from real tour recordings.

Requires ffmpeg and Pillow. Run from any directory with Python 3.
The full recordings remain linked from each preview; these are edited highlights.
"""
import argparse
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'artifacts/marketing/readme'
# Each shot: source start (seconds), camera center in the 1920 x 1080 stage, caption.
SHOTS = {
    'ask-to': [(7, 460, 540, 'Ask another agent for a second opinion'),
               (15, 490, 380, 'Follow the visible helper Session'),
               (31, 900, 830, 'Read the answer in the original conversation')],
    'handoff': [(4, 470, 550, 'Choose an existing Session for the handoff'),
                (16, 900, 710, 'Pass along the request, findings, and next action'),
                (33, 900, 830, 'Continue with the brief in the destination')],
    'fork': [(5, 450, 570, 'Fork the conversation from the Session menu'),
             (15, 540, 370, 'Keep the original and the fork side by side'),
             (33.4, 900, 870, 'Explore a different direction with context intact')],
    'task-briefs': [(9.2, 370, 350, 'Open the Task from the Project sidebar'),
                    (14, 730, 310, 'Read the goal and acceptance criteria'),
                    (18, 730, 420, 'Keep the goal attached to the work')],
    'workflow-templates': [(1, 380, 670, 'Open a saved workflow from the Task'),
                           (7, 1050, 400, 'Inspect the ordered agent steps'),
                           (13, 1310, 640, 'Configure the next step before running')],
    'full-file-review': [(7, 950, 310, 'Open the changed source file'),
                         (15, 1010, 310, 'Switch from the diff to the full file'),
                         (21, 1240, 450, 'Compare old and new code in split view')],
    'context-bank': [(2, 350, 250, 'Open the Project Context Bank'),
                     (11, 770, 260, 'Read the instructions for the repository'),
                     (21, 830, 260, 'Inspect instructions for a specific folder')],
    'skill-library': [(18, 350, 300, 'Find a skill by name'),
                      (23.5, 900, 280, 'Read its instructions before using it'),
                      (26, 900, 250, 'Inspect its source and installation details')],
}


def run(*args):
    subprocess.run(args, check=True)


def render(feature, font_path):
    source = ROOT / f'landing/assets/videos/tour/{feature}.mp4'
    with tempfile.TemporaryDirectory(prefix=f'termloop-readme-{feature}-') as folder:
        work = Path(folder)
        for i, (start, cx, cy, caption) in enumerate(SHOTS[feature]):
            panel = Image.new('RGB', (800, 80), '#121c29')
            draw = ImageDraw.Draw(panel)
            draw.rectangle((0, 0, 800*(i+1)//3, 3), fill='#f0b860')
            draw.text((20, 12), f'{i+1:02} / 03  {feature.replace("-", " ").upper()}',
                      font=ImageFont.truetype(font_path, 15), fill='#f0b860')
            draw.text((20, 39), caption, font=ImageFont.truetype(font_path, 21), fill='#f4f6fa')
            panel.save(work / f'{i}.png')
            # Smooth camera move for one second, then hold at 2.1x for readability.
            camera = ("crop=1920:1080:0:0,fps=20,"
                      "zoompan=z='1.6+0.5*min(on/20,1)':"
                      f"x='max(0,min(iw-iw/zoom,{cx}-iw/zoom/2))':"
                      f"y='max(0,min(ih-ih/zoom,{cy}-ih/zoom/2))':"
                      "d=1:s=800x450:fps=20")
            run('ffmpeg', '-v', 'error', '-threads', '2', '-ss', str(start), '-t', '5',
                '-i', str(source), '-loop', '1', '-framerate', '20', '-i', str(work / f'{i}.png'),
                '-filter_complex', f'[0:v]{camera}[shot];[shot][1:v]vstack=shortest=1[v]',
                '-map', '[v]', '-t', '5', '-an', '-c:v', 'libx264', '-crf', '16',
                '-pix_fmt', 'yuv420p', '-r', '20', '-threads', '2', '-y', str(work / f'{i}.mp4'))
        (work / 'shots.txt').write_text(''.join(f"file '{i}.mp4'\n" for i in range(3)))
        run('ffmpeg', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', str(work / 'shots.txt'),
            '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];'
            '[b][p]paletteuse=dither=none:diff_mode=rectangle',
            '-loop', '0', '-y', str(OUTPUT / f'{feature}.gif'))
    print(f'{feature}: {(OUTPUT / (feature + ".gif")).stat().st_size / 1024 / 1024:.2f} MiB', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font', default='/System/Library/Fonts/Supplemental/Arial.ttf')
    parser.add_argument('features', nargs='*', metavar='FEATURE')
    args = parser.parse_args()
    if unknown := set(args.features) - SHOTS.keys():
        parser.error(f'Unknown features: {sorted(unknown)}')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda name: render(name, args.font), args.features or SHOTS))


if __name__ == '__main__':
    main()
