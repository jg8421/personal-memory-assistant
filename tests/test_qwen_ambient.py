import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

spec = importlib.util.spec_from_file_location('qwen_worker', Path(__file__).resolve().parents[1] / 'scripts/qwen-ambient.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class QwenAdapterTests(unittest.TestCase):
    def setUp(self):
        self.adapter = module.QwenAmbientModel.__new__(module.QwenAmbientModel)

    def test_silence_does_not_call_the_language_model(self):
        self.adapter.model = SimpleNamespace(transcribe=lambda **kw: self.fail('Silence reached ASR'))
        with patch('faster_whisper.vad.get_speech_timestamps', return_value=[]):
            segments, info = self.adapter.transcribe(np.zeros(16000*60,dtype=np.float32))
        self.assertEqual(segments, [])
        self.assertEqual(info.duration, 60)

    def test_voice_spans_keep_original_offsets_and_skip_empty_text(self):
        def recognize(**kwargs):
            self.assertEqual(kwargs['language'], 'Chinese')
            self.assertFalse(kwargs['return_time_stamps'])
            self.assertEqual([len(a[0]) for a in kwargs['audio']], [16000, 32000])
            return [SimpleNamespace(text=' phrase '),SimpleNamespace(text='  ')]
        self.adapter.model = SimpleNamespace(transcribe=recognize)
        spans=[{'start':16000,'end':32000},{'start':64000,'end':96000}]
        with patch('faster_whisper.vad.get_speech_timestamps', return_value=spans):
            segments, info = self.adapter.transcribe(np.zeros(16000*60,dtype=np.float32))
        self.assertEqual(len(segments),1)
        self.assertEqual((segments[0].start,segments[0].end,segments[0].text),(1,2,'phrase'))
        self.assertEqual(info.duration,60)

    def test_incomplete_model_result_preserves_failure(self):
        self.adapter.model=SimpleNamespace(transcribe=lambda **kw: [])
        with patch('faster_whisper.vad.get_speech_timestamps',return_value=[{'start':0,'end':16000}]):
            with self.assertRaisesRegex(RuntimeError,'incomplete'):
                self.adapter.transcribe(np.zeros(16000,dtype=np.float32))


if __name__=='__main__':
    unittest.main()
