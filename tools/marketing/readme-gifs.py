#!/usr/bin/env python3
"""Convert the complete homepage edits into silent, full-frame README loops."""
import argparse
import json
import subprocess
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'artifacts/marketing/readme'


def render(feature):
    source = ROOT / f'landing/assets/videos/tour/{feature}.mp4'
    target = OUTPUT / f'{feature}.gif'
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=avg_frame_rate', '-of', 'json', str(source)]))
    # Keep archive motion at its recorded rate; cap newer recordings at 25 FPS.
    rate = min(25, float(Fraction(info['streams'][0]['avg_frame_rate'])))
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source),
        '-filter_complex', f'fps={rate:g},scale=960:540:flags=lanczos,split[a][b];'
        '[a]palettegen=max_colors=256:stats_mode=diff[p];'
        '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
        '-an', '-loop', '0', str(target)], check=True)
    print(f'{feature}: {target.stat().st_size / 1024 / 1024:.2f} MiB', flush=True)


def main():
    catalog = json.loads((ROOT / 'tools/marketing/catalog.json').read_text())
    names = [f['id'] for f in catalog]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('features', nargs='*')
    args = parser.parse_args()
    if unknown := set(args.features) - set(names):
        parser.error(f'Unknown features: {sorted(unknown)}')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for feature in args.features or names:
        render(feature)


if __name__ == '__main__':
    main()
