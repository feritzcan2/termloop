import json
import hashlib
import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch
import render


class RecordingGuardTests(unittest.TestCase):
    def check_rejected(self, reason, **overrides):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'demo.mp4'
            source.write_bytes(b'reviewed take')
            video = dict(codec_type='video', avg_frame_rate='30/1', width=1920, height=1080)
            video.update(overrides)
            metadata = {'format': {'duration': '12'}, 'streams': [video]}
            with patch.object(render, 'probe', return_value=metadata):
                with self.assertRaisesRegex(ValueError, reason):
                    render.validate_source(source, 'wrong checksum')

    def test_low_capture_rate_cannot_be_disguised_as_thirty_fps(self):
        self.check_rejected('too low', avg_frame_rate='3/1')

    def test_high_capture_rate_cannot_silently_drop_motion_frames(self):
        self.check_rejected('discard motion frames', avg_frame_rate='60/1')

    def test_no_upscale(self):
        self.check_rejected('do not upscale', width=1280, height=720)

    def test_only_the_reviewed_take_can_be_rendered(self):
        self.check_rejected('checksum differs')

    def test_missing_recording_does_not_fall_back_to_still_images(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(FileNotFoundError, 'continuous video recording is required'):
                render.validate_source(Path(folder) / 'missing.mp4', '')


class TimingTests(unittest.TestCase):
    def test_constant_speed_preserves_elapsed_time(self):
        timing = render.TimeMap(20, [[20, 4]])
        self.assertAlmostEqual(timing.mapped(20), 5)
        self.assertAlmostEqual(timing.mapped(12), 3)

    def test_acceleration_has_no_time_jumps_or_backward_frames(self):
        timing = render.TimeMap(30, [[10, 1], [20, 64], [30, 1]])
        times = [timing.mapped(i / 100) for i in range(3001)]
        self.assertTrue(all(a < b for a, b in zip(times, times[1:])))
        for start, end, *_ in timing.pieces:
            for boundary in (start, end):
                if 0 < boundary < 30:
                    h = .00001
                    left = (timing.mapped(boundary) - timing.mapped(boundary-h)) / h
                    right = (timing.mapped(boundary+h) - timing.mapped(boundary)) / h
                    self.assertAlmostEqual(left, right, places=5)

    def test_no_missing_or_overlapping_source_intervals(self):
        for runs in ([[10, 1]], [[20, 1], [15, 2], [30, 1]], [[31, 1]], [[30, 0]]):
            with self.assertRaises(ValueError):
                render.TimeMap(30, runs)

    def test_clicks_must_be_inside_the_selected_window_and_interval(self):
        timing = render.TimeMap(10, [[10, 1]])
        for click in ({'sourceTime': 11, 'x': 10, 'y': 10}, {'sourceTime': 1, 'x': 2000, 'y': 10}):
            with self.assertRaisesRegex(ValueError, 'outside'):
                render.filters_for(timing, [click], 10)


class ArchiveTests(unittest.TestCase):
    def test_trim_starts_at_the_requested_frame_and_preserves_the_remaining_sequence(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'landing').mkdir()
            source = root/'landing/approved.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                'nullsrc=s=1920x1080:r=20:d=0.5,geq=lum=16+N*10:cb=128:cr=128',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)], check=True)
            edit = {'archiveSource': 'approved.mp4', 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                'sourceFps': 20, 'sourceStart': .2, 'stepsAt': [0, .1, .2], 'posterAt': .1}
            with patch.object(render, 'ROOT', root):
                render.render({'id': 'quick-actions', 'steps': ['Write', 'Confirm', 'Launch']}, edit, None, root/'out')
            target = root/'out/quick-actions.mp4'
            def luma_frames(file):
                return subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(file),
                    '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-'])
            expected, actual = luma_frames(source)[4:], luma_frames(target)
            self.assertEqual(len(actual), 6)
            self.assertTrue(all(abs(a-b) <= 2 for a, b in zip(expected, actual)))
            report = json.loads((root/'out/quick-actions.json').read_text())
            self.assertEqual(report['sourceCoverage'], [.2, .5])
            self.assertEqual(report['frames'], 6)
            with patch.object(render, 'ROOT', root):
                for start in [-1, .01, .5]:
                    with self.subTest(start=start), self.assertRaisesRegex(ValueError, 'frame boundary'):
                        render.render({'id': 'quick-actions', 'steps': ['Write', 'Confirm', 'Launch']},
                            {**edit, 'sourceStart': start}, None, root/'out')

    def test_restore_preserves_the_approved_bytes_and_original_frame_rate(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'landing').mkdir()
            source = root/'landing/approved.mp4'
            source.write_bytes(b'approved earlier edit')
            edit = {'archiveSource': 'approved.mp4', 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                'sourceFps': 15, 'stepsAt': [0, 4, 10], 'posterAt': 6}
            info = {'format': {'duration': '15'}, 'streams': [{'codec_type': 'video',
                'width': 1920, 'height': 1080, 'avg_frame_rate': '15/1', 'nb_frames': '225'}]}
            with patch.object(render, 'ROOT', root), patch.object(render, 'probe', return_value=info), patch.object(render.subprocess, 'run'):
                render.render({'id': 'changes', 'steps': ['Open', 'Annotate', 'Send']}, edit, None, root/'out')
                self.assertEqual((root/'out/changes.mp4').read_bytes(), source.read_bytes())
                self.assertEqual(json.loads((root/'out/changes.json').read_text())['fps'], 15)
                source.write_bytes(b'different take')
                with self.assertRaisesRegex(ValueError, 'checksum differs'):
                    render.render({'id': 'changes', 'steps': ['Open', 'Annotate', 'Send']}, edit, None, root/'out')


class CloseupTests(unittest.TestCase):
    def test_invalid_crops_and_source_intervals_are_rejected(self):
        from render_shots import validate_shots
        edit = {'fps': 30, 'stepsAt': [0, 1, 2], 'posterAt': 2.5,
                'shots': [{'source': 0, 'start': 0, 'end': 3, 'duration': 3, 'crop': [0, 0, 960, 540]}]}
        validate_shots(edit, [4], render.crop_filter)
        for crop in ([0, 0, 960, 500], [-1, 0, 960, 540], [1500, 0, 960, 540], [0, 0, 0, 0]):
            with self.subTest(crop=crop), self.assertRaises(ValueError):
                render.crop_filter(crop)
        for changes in ({'source': 1}, {'start': -1}, {'end': 5}, {'duration': .01}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_shots({**edit, 'shots': [{**edit['shots'][0], **changes}]}, [4], render.crop_filter)

    def test_real_render_selects_only_the_requested_frames_in_order(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'landing').mkdir()
            source = root/'landing/source.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                'nullsrc=s=1920x1080:r=20:d=1,geq=lum=16+N*8:cb=128:cr=128',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)], check=True)
            edit = {'fps': 20, 'sources': [{'root': 'landing', 'source': 'source.mp4',
                    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest()}],
                'shots': [dict(source=0, start=.1, end=.3, duration=.2, crop=[0, 0, 960, 540]),
                          dict(source=0, start=.6, end=.8, duration=.2, crop=[960, 540, 960, 540])],
                'stepsAt': [0, .1, .2], 'posterAt': .3}
            with patch.object(render, 'ROOT', root):
                render.render({'id': 'demo', 'steps': ['One', 'Two', 'Three']}, edit, None, root/'out')
            def luma(file):
                return subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(file),
                    '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-'])
            original = luma(source)
            expected = original[2:6] + original[12:16]
            actual = luma(root/'out/demo.mp4')
            self.assertEqual(len(actual), len(expected))
            self.assertTrue(all(abs(a-b) <= 2 for a, b in zip(actual, expected)))
            report = json.loads((root/'out/demo.json').read_text())
            self.assertAlmostEqual(report['duration'], .4)
            self.assertEqual(report['shots'], edit['shots'])
            self.assertEqual(report['frames'], 8)


if __name__ == '__main__':
    unittest.main()
