"""Conservative local review gate; never treats repetition as approved speech."""
import json
import os
import math
import unicodedata
from collections import Counter
from pathlib import Path

POLICY = 'decoder-quality-review-v1'

class ReviewRequiredError(RuntimeError):
    pass

def assess_repetition(segments):
    texts = [''.join(c for c in segment['text'].casefold()
                     if not c.isspace() and not unicodedata.category(c).startswith('P'))
             for segment in segments if segment.get('text', '').strip()]
    texts = [text for text in texts if text]
    counts = Counter(texts)
    total = len(texts)
    unique = len(counts)
    maximum = max(counts.values(), default=0)
    duplicate_fraction = 1 - unique / total if total else 0
    required = total >= 8 and duplicate_fraction >= .5 and maximum >= 4
    return dict(reviewRequired=required, reason='repeated-segment-text' if required else '',
                segments=total, uniqueSegmentTexts=unique, maximumRepeat=maximum,
                duplicateFraction=duplicate_fraction, policy=POLICY)

def _fingerprint(source):
    source = Path(source)
    stat = source.stat()
    return dict(path=str(source.resolve()), bytes=stat.st_size, mtimeNs=stat.st_mtime_ns)

def assess_quality(segments):
    quality = assess_repetition(segments)
    low_probability = sum(isinstance(s.get('avg_logprob'), (int, float)) and
                          (not math.isfinite(s['avg_logprob']) or s['avg_logprob'] < -1.0)
                          for s in segments)
    excessive_compression = sum(isinstance(s.get('compression_ratio'), (int, float)) and
                                (not math.isfinite(s['compression_ratio']) or s['compression_ratio'] > 2.4)
                                for s in segments)
    reasons = [quality['reason']] if quality['reason'] else []
    if low_probability: reasons.append('decoder-log-probability-below-existing-threshold')
    if excessive_compression: reasons.append('decoder-compression-above-existing-threshold')
    quality.update(reviewRequired=bool(reasons), reason=';'.join(reasons),
                   lowProbabilitySegments=low_probability, excessiveCompressionSegments=excessive_compression)
    return quality

def _receipt(source, directory):
    source = Path(source)
    return Path(directory) / source.parent.name / (source.name + '.review.json')

def reject_cached_review(source, directory):
    receipt = _receipt(source, directory)
    if not receipt.exists():
        return
    record = json.loads(receipt.read_text(encoding='utf-8'))
    if record.get('policy') == POLICY and record.get('source') == _fingerprint(source):
        raise ReviewRequiredError('REVIEW_REQUIRED: 待人工核验；相同音频已暂存，未自动重处理或发布')

def require_review_if_repetitive(source, result, directory):
    quality = assess_quality(result.get('segments', []))
    if not quality['reviewRequired']:
        return quality
    receipt = _receipt(source, directory)
    receipt.parent.mkdir(parents=True, exist_ok=True)
    record = dict(policy=POLICY, reviewRequired=True, recognitionStatus='unverified',
                  source=_fingerprint(source), quality=quality, candidate=result,
                  originalAudioRetained=True)
    encoded = json.dumps(record, ensure_ascii=False, indent=2) + '\n'
    temporary = receipt.with_name(receipt.name + '.' + str(os.getpid()) + '.tmp')
    with temporary.open('w', encoding='utf-8') as target:
        target.write(encoded); target.flush(); os.fsync(target.fileno())
    os.replace(temporary, receipt)
    if receipt.read_text(encoding='utf-8') != encoded:
        raise RuntimeError('Local review receipt readback failed; original audio retained')
    raise ReviewRequiredError('REVIEW_REQUIRED: 待人工核验：重复或识别置信度异常；候选稿仅本地暂存，原音频保留')
