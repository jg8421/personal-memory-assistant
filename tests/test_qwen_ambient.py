import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
import tempfile
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

    def test_synthetic_warmup_prepares_lazy_runtime_without_becoming_a_transcript(self):
        calls=[]
        def recognize(**kwargs):
            calls.append(kwargs)
            self.assertEqual(len(kwargs['audio'][0][0]),16000)
            self.assertFalse(np.any(kwargs['audio'][0][0]))
            self.assertEqual(self.adapter.model.max_new_tokens,8)
            return [SimpleNamespace(text='discarded warmup output')]
        self.adapter.model=SimpleNamespace(transcribe=recognize,max_new_tokens=1024)
        with patch('faster_whisper.vad.get_speech_timestamps',return_value=[]) as vad:
            self.assertIsNone(self.adapter.warmup())
        self.assertEqual(len(calls),1)
        self.assertEqual(self.adapter.model.max_new_tokens,1024)
        self.assertGreaterEqual(self.adapter.warmup_seconds,0)
        vad.assert_called_once()

    def test_adjacent_sentences_merge_with_gap_and_duration_limits(self):
        spans=[{'start':0,'end':16000},{'start':24000,'end':48000},
               {'start':96000,'end':128000},{'start':132000,'end':600000}]
        actual=module.merge_speech_spans(spans)
        self.assertEqual(actual,[{'start':0,'end':48000},{'start':96000,'end':128000},
                                 {'start':132000,'end':600000}])
        self.assertEqual(spans[0]['end'],16000)

    def test_verified_terms_reach_qwen_and_invalid_update_keeps_last_valid(self):
        with tempfile.TemporaryDirectory() as folder:
            context=Path(folder)/'context.json'
            context.write_text('{"context":"technical interview","terms":["VerifiedProduct"]}',encoding='utf-8')
            self.adapter.context_file=str(context)
            self.adapter.context='Only transcribe audible speech.'
            def recognize(**kwargs):
                self.assertIn('VerifiedProduct',kwargs['context'])
                return [SimpleNamespace(text='VerifiedProduct')]
            self.adapter.model=SimpleNamespace(transcribe=recognize)
            with patch('faster_whisper.vad.get_speech_timestamps',return_value=[{'start':0,'end':16000}]):
                self.adapter.transcribe(np.zeros(16000,dtype=np.float32))
            previous=self.adapter.recognition_context()
            self.assertEqual(self.adapter.context_term_count,1)
            context.write_text('{invalid',encoding='utf-8')
            self.assertEqual(self.adapter.recognition_context(),previous)
            self.assertEqual(self.adapter.context_status,'invalid-using-last-valid')
            context.write_text('{"terms":["UpdatedProduct"]}',encoding='utf-8')
            self.assertIn('UpdatedProduct',self.adapter.recognition_context())
            self.assertEqual(self.adapter.context_status,'loaded')

    def test_context_never_reaches_model_for_silence(self):
        self.adapter.context='ReferenceName'
        self.adapter.model=SimpleNamespace(transcribe=lambda **kw:self.fail('Silence reached model'))
        with patch('faster_whisper.vad.get_speech_timestamps',return_value=[]):
            segments,_=self.adapter.transcribe(np.zeros(16000*60,dtype=np.float32))
        self.assertEqual(segments,[])
    def construct(self, device='xpu', available=True, actual='xpu'):
        calls=[]
        torch=SimpleNamespace(set_num_threads=lambda n:None,float16='float16',float32='float32',
                              cuda=SimpleNamespace(is_available=lambda:True),
                              xpu=SimpleNamespace(is_available=lambda:available))
        def factory(*args,**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(model=SimpleNamespace(parameters=lambda:iter([
                SimpleNamespace(device=SimpleNamespace(type=actual))])))
        qwen=SimpleNamespace(Qwen3ASRModel=SimpleNamespace(from_pretrained=factory))
        with tempfile.TemporaryDirectory() as model, patch.dict('sys.modules',{'torch':torch,'qwen_asr':qwen}):
            adapter=module.QwenAmbientModel(model,device,'float16')
        return adapter,calls

    def test_xpu_is_explicit_and_verifies_parameter_placement(self):
        adapter,calls=self.construct()
        self.assertEqual(adapter.actual_device,'xpu')
        self.assertEqual(calls[0]['device_map'],'xpu:0')
        self.assertEqual(calls[0]['dtype'],'float16')
        self.assertTrue(calls[0]['local_files_only'])

    def test_unavailable_xpu_fails_without_silent_cpu_selection(self):
        with self.assertRaisesRegex(RuntimeError,'XPU is not available'):
            self.construct(available=False)

    def test_gpu_request_rejects_cpu_placement(self):
        with self.assertRaisesRegex(RuntimeError,'placement differs'):
            self.construct(actual='cpu')

    def test_unknown_device_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'device must'):
            self.construct(device='not-a-backend')


if __name__=='__main__':
    unittest.main()
