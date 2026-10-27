"""Defer Qwen 0.0.6's optional Japanese alignment dependency; no downloads.

Run explicitly inside an isolated ASR environment. The ambient adapter does not
request forced alignment. Japanese forced alignment still requires nagisa when
that feature is actually invoked. Preserve the original vendor source once.
"""
from importlib.metadata import distribution, version
from pathlib import Path


def main():
    if version('qwen-asr') != '0.0.6':
        raise RuntimeError('Only the reviewed qwen-asr 0.0.6 source is supported')
    source = Path(distribution('qwen-asr').locate_file(
        'qwen_asr/inference/qwen3_forced_aligner.py'))
    text = source.read_text(encoding='utf-8')
    marker = '        import nagisa  # Optional Japanese alignment dependency; unused by ASR.'
    if marker in text:
        print('Optional alignment import already deferred')
        return
    if '\nimport nagisa\n' not in text or '        words = nagisa.tagging(text).words' not in text:
        raise RuntimeError('Vendor source differs; review it before editing')
    backup = source.with_suffix('.py.original')
    if backup.exists():
        raise RuntimeError('An existing backup needs review; it will not be overwritten')
    updated = text.replace('\nimport nagisa\n', '\n', 1).replace(
        '        words = nagisa.tagging(text).words',
        marker + '\n        words = nagisa.tagging(text).words', 1)
    backup.write_bytes(source.read_bytes())
    source.write_text(updated, encoding='utf-8')
    print('Optional Japanese alignment import deferred; original preserved')


if __name__ == '__main__':
    main()
