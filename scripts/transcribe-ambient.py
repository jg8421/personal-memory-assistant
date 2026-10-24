"""Offline speech recognition worker. Audio and text never leave this computer."""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['OMP_NUM_THREADS'] = '2'
import sys
import json
import ctypes
from ctypes import wintypes
from pathlib import Path
from faster_whisper import WhisperModel

if os.name == 'nt':
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.SetPriorityClass.restype = wintypes.BOOL
    if not kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000):
        raise OSError(ctypes.get_last_error(), 'Unable to set background priority')

settings = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))['transcription']
model = WhisperModel(settings['modelPath'], device='cpu', compute_type='int8',
                     cpu_threads=2, num_workers=1, local_files_only=True)
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        segments, info = model.transcribe(request['path'], language=settings.get('language', 'zh'),
            beam_size=1, best_of=1, condition_on_previous_text=False,
            vad_filter=True, vad_parameters={'min_silence_duration_ms': 500},
            no_speech_threshold=0.6, log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4, word_timestamps=False)
        result = [{'start': round(s.start, 3), 'end': round(s.end, 3), 'text': s.text.strip()}
                  for s in segments if s.text.strip()]
        print(json.dumps({'id': request['id'], 'ok': True, 'duration': info.duration,
                          'language': info.language, 'segments': result}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({'id': request.get('id'), 'ok': False,
                          'error': type(error).__name__ + ': ' + str(error)}, ensure_ascii=False), flush=True)
