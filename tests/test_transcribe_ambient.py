import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
import tempfile
import json
import io
import wave
import numpy as np
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ambient_worker', Path(__file__).resolve().parents[1] / 'scripts/transcribe-ambient.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Model:
    def __init__(self, error=None):
        self.error = error

    def transcribe(self, audio, **kwargs):
        def segments():
            if self.error:
                raise self.error
            yield SimpleNamespace(start=0, end=1, text='sample')
        return segments(), SimpleNamespace(duration=60, language='zh')


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.patch = patch.object(worker, 'prepare_cuda')
        self.patch.start()
        self.addCleanup(self.patch.stop)
        decoder = patch.object(worker, 'load_audio_file', side_effect=lambda value, path=None: value)
        decoder.start()
        self.addCleanup(decoder.stop)
        self.settings = {'device': 'cuda', 'modelPath': 'local-model', 'gpuRetrySeconds': 30}

    def test_gpu_initialization_failure_retries_after_cooldown(self):
        now = [0]
        calls = []
        def factory(path, **opts):
            calls.append(opts['device'])
            if opts['device'] == 'cuda' and now[0] == 0:
                raise OSError('missing CUDA library')
            self.assertTrue(opts['local_files_only'])
            return Model()
        engine = worker.Transcriber(self.settings, factory, clock=lambda: now[0])
        self.assertEqual(engine.transcribe('audio')['device'], 'cpu')
        self.assertEqual(calls, ['cuda', 'cpu'])
        now[0] = 31
        self.assertEqual(engine.transcribe('audio')['device'], 'cuda')
        self.assertEqual(engine.fallback, '')

    def test_gpu_generator_failure_retries_same_audio_on_cpu(self):
        seen = []
        def factory(path, **opts):
            seen.append(opts['device'])
            return Model(RuntimeError('CUDA out of memory')) if opts['device'] == 'cuda' else Model()
        engine = worker.Transcriber(self.settings, factory)
        result = engine.transcribe('audio')
        self.assertEqual(result['device'], 'cpu')
        self.assertEqual(result['segments'][0]['text'], 'sample')
        self.assertEqual(seen, ['cuda', 'cpu'])

    def test_bad_audio_does_not_disable_gpu(self):
        engine = worker.Transcriber(self.settings, lambda *a, **k: Model(ValueError('invalid audio data')))
        with self.assertRaises(ValueError):
            engine.transcribe('bad-audio')
        self.assertEqual(engine.device, 'cuda')
        self.assertEqual(engine.fallback, '')

    def test_explicit_cpu_preserves_int8_and_offline_options(self):
        settings = {**self.settings, 'device': 'cpu'}
        def factory(path, **opts):
            self.assertEqual(opts['device'], 'cpu')
            self.assertEqual(opts['compute_type'], 'int8')
            self.assertEqual(opts['cpu_threads'], 2)
            self.assertTrue(opts['local_files_only'])
            return Model()
        engine = worker.Transcriber(settings, factory)
        self.assertEqual(engine.transcribe('audio')['device'], 'cpu')
        worker.prepare_cuda.assert_not_called()

    def test_disabled_fallback_and_error_health(self):
        states = []
        engine = worker.Transcriber({**self.settings, 'fallbackToCpu': False},
            lambda *a, **k: Model(RuntimeError('CUDA error')), states.append)
        with self.assertRaises(RuntimeError):
            engine.transcribe('audio')
        self.assertEqual(states[-1]['status'], 'error')
        self.assertEqual(states[-1]['modelPath'], 'local-model')
        self.assertEqual(engine.device, 'cuda')

    def test_qwen_uses_torch_precision_without_whisper_cuda_preload(self):
        options = []
        def factory(path, **kwargs):
            options.append(kwargs)
            return Model()
        engine = worker.Transcriber({**self.settings, 'backend': 'qwen3-asr'}, factory)
        self.assertEqual(engine.transcribe('audio')['computeType'], 'float16')
        worker.prepare_cuda.assert_not_called()
        engine.use_cpu(RuntimeError('CUDA out of memory'))
        self.assertEqual(engine.compute, 'float32')
        self.assertEqual([x['compute_type'] for x in options], ['float16', 'float32'])


class StartupPriorityTests(unittest.TestCase):
    @unittest.skipUnless(worker.os.name == 'nt', 'Windows scheduling order')
    def test_model_initializes_before_inference_priority_is_lowered(self):
        events=[]
        current=lambda:1
        priority=lambda handle,value:events.append(('priority',value)) or True
        kernel=SimpleNamespace(GetCurrentProcess=current,SetPriorityClass=priority)
        def construct(*args,**kwargs):
            events.append('load')
            return SimpleNamespace(device='cpu',compute='int8')
        with tempfile.TemporaryDirectory() as folder:
            config=Path(folder)/'config.json'
            config.write_text(json.dumps({'transcription':{'modelPath':'local-model'}}),encoding='utf8')
            with patch.object(worker,'Transcriber',side_effect=construct), \
                 patch.object(worker.ctypes,'WinDLL',return_value=kernel), \
                 patch.dict('sys.modules',{'faster_whisper':SimpleNamespace(WhisperModel=object)}), \
                 patch.object(worker.sys,'argv',['worker',str(config)]), \
                 patch.object(worker.sys,'stdin',io.StringIO('')), \
                 patch.object(worker.sys,'stdout',io.StringIO()):
                worker.main()
        self.assertEqual(events,['load',('priority',0x4000)])


class CapturedAudioTests(unittest.TestCase):
    def test_pcm_is_decoded_without_external_decoder_and_original_is_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'closed.wav'
            data=np.tile(np.array([-32768,-1,0,32767],dtype='<i2'),4000)
            with wave.open(str(source),'wb') as output:
                output.setparams((1,2,16000,0,'NONE','not compressed'))
                output.writeframes(data.tobytes())
            before=source.read_bytes()
            with patch.object(worker.subprocess,'run') as run:
                result=worker.load_audio_file(source)
            run.assert_not_called()
            np.testing.assert_array_equal(result,data.astype(np.float32)/32768.0)
            self.assertEqual(source.read_bytes(),before)

    def test_empty_pcm_is_retained_instead_of_becoming_a_success(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'empty.wav'
            with wave.open(str(source),'wb') as output:output.setparams((1,2,16000,0,'NONE','not compressed'))
            with self.assertRaisesRegex(ValueError,'original retained'):
                worker.load_audio_file(source)
            self.assertTrue(source.exists())

    def test_existing_ffmpeg_fallback_is_hidden_bounded_and_does_not_modify_input(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'other.flac';source.write_bytes(b'non-wav fixture')
            output=SimpleNamespace(returncode=0,stdout=np.zeros(16000,dtype='<i2').tobytes())
            with patch.object(worker.subprocess,'run',return_value=output) as run:
                result=worker.load_audio_file(source,'configured-ffmpeg')
            self.assertEqual(len(result),16000)
            self.assertIn('-nostdin',run.call_args.args[0]);self.assertEqual(run.call_args.kwargs['timeout'],120)
            if worker.os.name=='nt':self.assertEqual(run.call_args.kwargs['creationflags'],worker.subprocess.CREATE_NO_WINDOW)
            self.assertEqual(source.read_bytes(),b'non-wav fixture')


if __name__ == '__main__':
    unittest.main()
