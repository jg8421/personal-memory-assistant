"""Persistent offline ASR with an explicit GPU preference and CPU recovery."""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['OMP_NUM_THREADS'] = '2'
import sys
import json
import ctypes
import gc
import time
from datetime import datetime, timezone
from ctypes import wintypes
from pathlib import Path

_dll_handles = []
_dll_directories = set()
_cuda_ready = False


def prepare_cuda(settings):
    global _cuda_ready
    if os.name != 'nt' or _cuda_ready:
        return
    directories = list(settings.get('cudaLibraryDirs', []))
    if os.environ.get('CUDA_PATH'):
        directories.append(str(Path(os.environ['CUDA_PATH']) / 'bin'))
    directories.append(str(Path(__file__).resolve().parents[1] /
                           'runtime/cuda-python/nvidia/cudnn/bin'))
    for directory in dict.fromkeys(directories):
        directory = str(Path(directory).resolve())
        if Path(directory).is_dir() and directory not in _dll_directories:
            _dll_handles.append(os.add_dll_directory(directory))
            os.environ['PATH'] = directory + os.pathsep + os.environ.get('PATH', '')
            _dll_directories.add(directory)
    # Fail in Python before a missing native library can abort the worker.
    for library in ('cublas64_12.dll', 'cublasLt64_12.dll', 'cudnn64_9.dll'):
        _dll_handles.append(ctypes.WinDLL(library))
    _cuda_ready = True


def gpu_error(error):
    text = str(error).lower()
    return any(word in text for word in ('cuda', 'cudnn', 'cublas', 'gpu', 'out of memory'))


class Transcriber:
    def __init__(self, settings, model_factory, health=None, clock=time.monotonic):
        self.settings = settings
        self.factory = model_factory
        self.health = health or (lambda value: None)
        self.clock = clock
        self.preferred = settings.get('device', 'cpu')
        if settings.get('backend', 'faster-whisper') not in ('faster-whisper', 'qwen3-asr'):
            raise ValueError('Unknown offline transcription backend')
        if self.preferred not in ('cpu', 'cuda', 'auto'):
            raise ValueError('transcription.device must be cpu, cuda or auto')
        self.model = None
        self.device = None
        self.compute = None
        self.fallback = ''
        self.next_gpu_attempt = 0
        self.retry_seconds = max(30, float(settings.get('gpuRetrySeconds', 300)))
        self.prefer_gpu()

    def report(self, **extra):
        value = {'pid': os.getpid(), 'checkedAt': datetime.now(timezone.utc).isoformat(),
                 'requestedDevice': self.preferred, 'device': self.device,
                 'modelPath': self.settings['modelPath'],
                 'backend': self.settings.get('backend', 'faster-whisper'),
                 'computeType': self.compute, 'gpuFallbackReason': self.fallback}
        value.update(extra)
        if self.settings.get('backend') == 'qwen3-asr' and self.model:
            value.update(contextStatus=getattr(self.model, 'context_status', 'unknown'),
                         contextTerms=getattr(self.model, 'context_term_count', 0),
                         contextSha256=getattr(self.model, 'context_sha256', None))
        self.health(value)

    def load(self, device):
        qwen = self.settings.get('backend') == 'qwen3-asr'
        if device == 'cuda' and not qwen:
            prepare_cuda(self.settings)
        if qwen:
            compute = 'float16' if device == 'cuda' else 'float32'
        else:
            compute = self.settings.get('computeType', 'int8_float16') if device == 'cuda' else 'int8'
        options = dict(device=device, compute_type=compute,
                       cpu_threads=int(self.settings.get('cpuThreads', 2)),
                       num_workers=1, local_files_only=True)
        if qwen:
            options.update(context_file=self.settings.get('contextFile'), context=self.settings.get('context', ''),
                           merge_gap_seconds=self.settings.get('mergeGapSeconds', 1.0),
                           max_speech_seconds=self.settings.get('maxSpeechSeconds', 30.0))
        model = self.factory(self.settings['modelPath'], **options)
        self.model, self.device, self.compute = model, device, compute

    def use_cpu(self, error):
        self.fallback = type(error).__name__ + ': ' + str(error)
        self.next_gpu_attempt = self.clock() + self.retry_seconds
        if self.device != 'cpu':
            self.model = None
            gc.collect()
            self.load('cpu')

    def prefer_gpu(self):
        if self.preferred == 'cpu':
            self.load('cpu')
        else:
            try:
                self.load('cuda')
                self.fallback = ''
            except Exception as error:
                if not self.settings.get('fallbackToCpu', True):
                    raise
                self.use_cpu(error)
        self.report(status='ready')

    def recognize(self, audio):
        segments, info = self.model.transcribe(audio, language=self.settings.get('language', 'zh'),
            beam_size=1, best_of=1, condition_on_previous_text=False,
            vad_filter=True, vad_parameters={'min_silence_duration_ms': 500},
            no_speech_threshold=0.6, log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4, word_timestamps=False)
        result = [{'start': round(s.start, 3), 'end': round(s.end, 3), 'text': s.text.strip()}
                  for s in segments if s.text.strip()]
        return {'ok': True, 'duration': info.duration, 'language': info.language,
                'segments': result, 'device': self.device, 'computeType': self.compute}

    def transcribe(self, audio):
        if self.preferred != 'cpu' and self.device == 'cpu' and self.clock() >= self.next_gpu_attempt:
            self.prefer_gpu()
        started = self.clock()
        self.report(status='transcribing')
        try:
            try:
                result = self.recognize(audio)
            except Exception as error:
                if self.device != 'cuda' or not gpu_error(error) or not self.settings.get('fallbackToCpu', True):
                    raise
                self.use_cpu(error)
                result = self.recognize(audio)
            self.report(status='ready', lastDurationSeconds=result['duration'],
                        elapsedSeconds=round(self.clock() - started, 3),
                        lastTranscribedAt=datetime.now(timezone.utc).isoformat())
            return result
        except Exception as error:
            self.report(status='error', error=type(error).__name__ + ': ' + str(error))
            raise


def main():
    if os.name == 'nt':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.SetPriorityClass.restype = wintypes.BOOL
        if not kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000):
            raise OSError(ctypes.get_last_error(), 'Unable to set background priority')
    config = Path(sys.argv[1])
    settings = json.loads(config.read_text(encoding='utf-8-sig'))['transcription']
    state = config.parent / 'state/ambient-transcriber.json'

    def health(value):
        state.parent.mkdir(parents=True, exist_ok=True)
        temp = state.with_name(state.name + '.' + str(os.getpid()) + '.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(temp, state)

    if settings.get('backend', 'faster-whisper') == 'qwen3-asr':
        import importlib.util
        spec = importlib.util.spec_from_file_location('qwen_ambient', Path(__file__).with_name('qwen-ambient.py'))
        adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adapter)
        factory = adapter.QwenAmbientModel
    else:
        from faster_whisper import WhisperModel
        factory = WhisperModel
    worker = Transcriber(settings, factory, health)
    print(json.dumps({'ready': True, 'device': worker.device, 'computeType': worker.compute}), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            result = worker.transcribe(request['path'])
            print(json.dumps({'id': request['id'], **result}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({'id': request.get('id'), 'ok': False,
                              'error': type(error).__name__ + ': ' + str(error)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
