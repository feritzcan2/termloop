import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import render


class RecordingGuardTests(unittest.TestCase):
    def check_rate_rejected(self, rate, reason):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'demo.mp4'
            source.touch()
            metadata = {'format': {'duration': '12'}, 'streams': [{'avg_frame_rate': rate}]}
            with patch.object(render, 'RECORDINGS', Path(folder)), patch.object(render, 'probe', return_value=metadata):
                with self.assertRaisesRegex(ValueError, reason):
                    render.render({'id': 'demo', 'legacy': False})

    def test_low_capture_rate_cannot_be_disguised_as_thirty_fps(self):
        self.check_rate_rejected('3/1', 'too low')

    def test_high_capture_rate_cannot_silently_drop_motion_frames(self):
        self.check_rate_rejected('60/1', 'discard motion frames')

    def test_missing_recording_does_not_fall_back_to_still_images(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(render, 'RECORDINGS', Path(folder)):
            with self.assertRaisesRegex(FileNotFoundError, 'continuous video recording is required'):
                render.render({'id': 'demo', 'legacy': False})


if __name__ == '__main__':
    unittest.main()
