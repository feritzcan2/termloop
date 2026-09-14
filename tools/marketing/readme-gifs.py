#!/usr/bin/env python3
"""Convert the complete homepage edits into silent, full-frame README loops."""
import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'artifacts/marketing/readme'


def render(feature):
    source = ROOT / f'landing/assets/videos/tour/{feature}.mp4'
    target = OUTPUT / f'{feature}.gif'
    # GIF delays use centiseconds: 25 fps is exact and keeps click motion smooth.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source),
        '-filter_complex', 'fps=25,scale=960:540:flags=lanczos,split[a][b];'
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
