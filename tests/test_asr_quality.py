import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('asr_quality', Path(__file__).parents[1] / 'scripts/asr_quality.py')
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)

class QualityReviewTests(unittest.TestCase):
    def test_exhausted_decode_thresholds_require_review_without_deleting_words(self):
        self.assertTrue(quality.assess_quality([{'text':'possible speech','avg_logprob':-1.2}])['reviewRequired'])
        self.assertTrue(quality.assess_quality([{'text':'possible speech','compression_ratio':2.5}])['reviewRequired'])
        self.assertFalse(quality.assess_quality([{'text':'possible speech','avg_logprob':-.5,'compression_ratio':1.3}])['reviewRequired'])

    def test_repetition_is_review_not_silence_or_approved_text(self):
        segments = [{'text': '重复。'}] * 16 + [{'text': '其他' + str(i)} for i in range(6)]
        result = quality.assess_repetition(segments)
        self.assertTrue(result['reviewRequired'])
        self.assertEqual(result['maximumRepeat'], 16)
        self.assertFalse(quality.assess_repetition([{'text': str(i)} for i in range(22)])['reviewRequired'])
        self.assertFalse(quality.assess_repetition([{'text': '可以'}] * 3)['reviewRequired'])

    def test_review_keeps_input_and_does_not_create_formal_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / '2026-10-28' / 'sample.wav'
            source.parent.mkdir(); source.write_bytes(b'original closed audio')
            review = root / 'local-state' / 'review'
            result = dict(ok=True, duration=60, segments=[{'text': '重复'}] * 10)
            with self.assertRaises(quality.ReviewRequiredError):
                quality.require_review_if_repetitive(source, result, review)
            self.assertEqual(source.read_bytes(), b'original closed audio')
            receipt = next(review.rglob('*.json'))
            self.assertTrue(json.loads(receipt.read_text(encoding='utf-8'))['reviewRequired'])
            self.assertFalse((root / 'formal-output').exists())
            with self.assertRaises(quality.ReviewRequiredError):
                quality.reject_cached_review(source, review)
            source.write_bytes(b'changed closed audio')
            quality.reject_cached_review(source, review)

    def test_short_or_nonrepeated_text_creates_no_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = {'segments': [{'text': 'unique ' + str(i)} for i in range(10)]}
            self.assertFalse(quality.require_review_if_repetitive(root/'absent.wav', result, root/'review')['reviewRequired'])
            self.assertFalse((root/'review').exists())
