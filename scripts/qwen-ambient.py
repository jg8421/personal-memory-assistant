"""Offline Qwen3-ASR adapter for the existing timestamped audio pipeline."""
from types import SimpleNamespace
from pathlib import Path
import json
import hashlib
import time


def merge_speech_spans(spans, sample_rate=16000, max_gap_seconds=1.0, max_duration_seconds=30.0):
    """Keep nearby sentences together without bridging long pauses or losing offsets."""
    merged = []
    for span in spans:
        start, end = int(span['start']), int(span['end'])
        if start < 0 or end <= start:
            raise ValueError('Invalid voice activity interval')
        if merged and start < merged[-1]['start']:
            raise ValueError('Voice activity intervals must be sorted')
        if (merged and start - merged[-1]['end'] <= max_gap_seconds * sample_rate
                and end - merged[-1]['start'] <= max_duration_seconds * sample_rate):
            merged[-1]['end'] = max(merged[-1]['end'], end)
        else:
            merged.append({'start': start, 'end': end})
    return merged


class QwenAmbientModel:
    def __init__(self, model_path, device, compute_type, cpu_threads=2,
                 num_workers=1, local_files_only=True, max_new_tokens=1024,
                 context_file=None, context='', merge_gap_seconds=1.0, max_speech_seconds=30.0):
        import torch
        from qwen_asr import Qwen3ASRModel
        if not local_files_only:
            raise ValueError('Ambient models must use a local model directory')
        if not Path(model_path).is_dir():
            raise ValueError('Local Qwen model directory is missing')
        torch.set_num_threads(cpu_threads)
        self.context_file = context_file
        self.context = context
        self.merge_gap_seconds = max(0, min(2, float(merge_gap_seconds)))
        self.max_speech_seconds = max(5, min(60, float(max_speech_seconds)))
        self.recognition_context()
        if device not in ('cpu', 'cuda', 'xpu'):
            raise ValueError('Qwen device must be cpu, cuda or xpu')
        if device == 'cuda' and not torch.cuda.is_available():
            raise RuntimeError('CUDA is not available in the Qwen Python runtime')
        if device == 'xpu' and (not hasattr(torch, 'xpu') or not torch.xpu.is_available()):
            raise RuntimeError('Intel XPU is not available in the Qwen Python runtime')
        accelerated = device in ('cuda', 'xpu')
        self.model = Qwen3ASRModel.from_pretrained(
            model_path, dtype=torch.float16 if accelerated else torch.float32,
            device_map=device + ':0' if accelerated else 'cpu',
            attn_implementation='sdpa', local_files_only=True,
            max_inference_batch_size=1, max_new_tokens=max_new_tokens)
        if accelerated:
            raw = getattr(self.model, 'model', None)
            if raw is None or not hasattr(raw, 'parameters'):
                raise RuntimeError('Cannot verify the loaded Qwen model device')
            actual = {parameter.device.type for parameter in raw.parameters()}
            if actual != {device}:
                raise RuntimeError('Qwen model placement differs from requested device: ' + repr(actual))
        self.actual_device = device

    def warmup(self):
        """Initialize lazy audio/native paths before background inference begins.

        This is synthetic silence, never a transcript or recognition acceptance
        sample. It uses the packaged local VAD asset and the already loaded model.
        """
        import numpy as np
        from faster_whisper.vad import get_speech_timestamps, VadOptions
        started=time.perf_counter()
        silence=np.zeros(16000,dtype=np.float32)
        get_speech_timestamps(silence,VadOptions(min_silence_duration_ms=500))
        limit=getattr(self.model,'max_new_tokens',None)
        if limit is not None:self.model.max_new_tokens=min(limit,8)
        try:
            self.model.transcribe(audio=[(silence,16000)],context='',language='Chinese',return_time_stamps=False)
        finally:
            if limit is not None:self.model.max_new_tokens=limit
        self.warmup_seconds=time.perf_counter()-started

    def recognition_context(self):
        base = getattr(self, 'context', '')
        context_file = getattr(self, 'context_file', None)
        if not context_file:
            text = base[:2000]
            self.context_status = 'disabled' if not text else 'inline'
            self.context_term_count = 0
        else:
            try:
                path = Path(context_file)
                stat = path.stat()
                signature = (stat.st_mtime_ns, stat.st_size)
                if signature == getattr(self, '_context_signature', None):
                    return self._context_text
                if stat.st_size > 65536:
                    raise ValueError('Context file exceeds 64 KiB')
                data = json.loads(path.read_text(encoding='utf-8-sig'))
                terms = data.get('terms', [])
                domain = data.get('context', '')
                if (not isinstance(domain, str) or not isinstance(terms, list) or len(terms) > 200
                        or any(not isinstance(term, str) or not term.strip() or len(term) > 80 for term in terms)):
                    raise ValueError('Invalid context or verified vocabulary')
                terms = list(dict.fromkeys(term.strip() for term in terms))
                text = '\n'.join(part for part in (base, domain,
                    ('参考词汇：' + '、'.join(terms)) if terms else '') if part)
                if len(text) > 2000:
                    raise ValueError('Recognition context exceeds 2000 characters')
                self._context_signature = signature
                self.context_term_count = len(terms)
                self.context_status = 'loaded'
            except (OSError, ValueError, TypeError, AttributeError):
                self.context_status = 'invalid-using-last-valid'
                return getattr(self, '_context_text', base[:2000])
        self._context_text = text
        self.context_sha256 = hashlib.sha256(text.encode('utf-8')).hexdigest()
        return text

    def transcribe(self, audio, language='zh', **unused):
        import numpy as np
        from faster_whisper.audio import decode_audio
        from faster_whisper.vad import get_speech_timestamps, VadOptions
        samples = np.asarray(audio, dtype=np.float32) if isinstance(audio, np.ndarray) else decode_audio(audio)
        duration = len(samples) / 16000
        spans = get_speech_timestamps(samples, VadOptions(min_silence_duration_ms=500))
        spans = merge_speech_spans(spans,
            max_gap_seconds=getattr(self, 'merge_gap_seconds', 1.0),
            max_duration_seconds=getattr(self, 'max_speech_seconds', 30.0))
        if not spans:
            return [], SimpleNamespace(duration=duration, language=language or 'zh')
        aliases = {'zh': 'Chinese', 'en': 'English', 'yue': 'Cantonese', 'ja': 'Japanese'}
        forced_language = aliases.get(language, language) if language else None
        results = self.model.transcribe(
            audio=[(samples[span['start']:span['end']], 16000) for span in spans],
            context=self.recognition_context(), language=forced_language, return_time_stamps=False)
        if len(results) != len(spans):
            raise RuntimeError('Qwen returned an incomplete audio batch')
        segments = [SimpleNamespace(start=span['start']/16000, end=span['end']/16000,
                                    text=result.text.strip())
                    for span, result in zip(spans, results) if result.text.strip()]
        return segments, SimpleNamespace(duration=duration, language=language or 'zh')
