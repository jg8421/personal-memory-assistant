"""Offline Qwen3-ASR adapter for the existing timestamped audio pipeline."""
from types import SimpleNamespace


class QwenAmbientModel:
    def __init__(self, model_path, device, compute_type, cpu_threads=2,
                 num_workers=1, local_files_only=True, max_new_tokens=1024):
        import torch
        from qwen_asr import Qwen3ASRModel
        if not local_files_only:
            raise ValueError('Ambient models must use a local model directory')
        from pathlib import Path
        if not Path(model_path).is_dir():
            raise ValueError('Local Qwen model directory is missing')
        torch.set_num_threads(cpu_threads)
        if device == 'cuda' and not torch.cuda.is_available():
            raise RuntimeError('CUDA is not available in the Qwen Python runtime')
        self.model = Qwen3ASRModel.from_pretrained(
            model_path, dtype=torch.float16 if device == 'cuda' else torch.float32,
            device_map='cuda:0' if device == 'cuda' else 'cpu',
            attn_implementation='sdpa', local_files_only=True,
            max_inference_batch_size=1, max_new_tokens=max_new_tokens)

    def transcribe(self, audio, language='zh', **unused):
        import numpy as np
        from faster_whisper.audio import decode_audio
        from faster_whisper.vad import get_speech_timestamps, VadOptions
        samples = np.asarray(audio, dtype=np.float32) if isinstance(audio, np.ndarray) else decode_audio(audio)
        duration = len(samples) / 16000
        spans = get_speech_timestamps(samples, VadOptions(min_silence_duration_ms=500))
        if not spans:
            return [], SimpleNamespace(duration=duration, language=language or 'zh')
        aliases = {'zh': 'Chinese', 'en': 'English', 'yue': 'Cantonese', 'ja': 'Japanese'}
        forced_language = aliases.get(language, language) if language else None
        results = self.model.transcribe(
            audio=[(samples[span['start']:span['end']], 16000) for span in spans],
            language=forced_language, return_time_stamps=False)
        if len(results) != len(spans):
            raise RuntimeError('Qwen returned an incomplete audio batch')
        segments = [SimpleNamespace(start=span['start']/16000, end=span['end']/16000,
                                    text=result.text.strip())
                    for span, result in zip(spans, results) if result.text.strip()]
        return segments, SimpleNamespace(duration=duration, language=language or 'zh')
