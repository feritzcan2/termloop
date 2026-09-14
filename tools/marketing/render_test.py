import json
import hashlib
import tempfile
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

    def test_accepted_ask_to_pacing(self):
        edit = json.loads((render.ROOT/'tools/marketing/edits.json').read_text())['ask-to']
        timing = render.TimeMap(151.933, edit['runs'])
        self.assertAlmostEqual(timing.mapped(23.3), 1.28, delta=.03)
        self.assertAlmostEqual(timing.mapped(65)-timing.mapped(30.5), 1.40, delta=.08)
        self.assertAlmostEqual(timing.mapped(151.933), 17.2, delta=.04)

    def test_clicks_must_be_inside_the_selected_window_and_interval(self):
        timing = render.TimeMap(10, [[10, 1]])
        for click in ({'sourceTime': 11, 'x': 10, 'y': 10}, {'sourceTime': 1, 'x': 2000, 'y': 10}):
            with self.assertRaisesRegex(ValueError, 'outside'):
                render.filters_for(timing, [click], 10)


class ArchiveTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
