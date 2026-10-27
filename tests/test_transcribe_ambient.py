import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
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


if __name__ == '__main__':
    unittest.main()
