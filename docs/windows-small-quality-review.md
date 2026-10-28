# Small-model quality review: limits and protective changes

This follows the morning recovery correction. Continuous capture and successful
local writes do not establish that recognized words are accurate.

## Observed issue and parameter comparison

One natural 60-second transcript had 28 segments, 12 unique segment texts and one
text repeated 16 times. Other observed natural transcripts had unique segment
texts. The capture/transcription queue later returned to three preserved zero-byte
failures; it was not continuously growing during the final quiet observation.

The installed legacy worker explicitly fixed temperature at zero, whereas the
earlier source baseline and generic worker use the library's default temperature
fallback. Model, int8 compute, one worker, beam/best-of settings, disabled previous
text conditioning, VAD with 500 ms silence, log-probability -1.0, no-speech 0.6 and
compression-ratio 2.4 settings otherwise matched. The explicit temperature is a
configuration drift, but the limited tests do not prove it is the sole cause of
repetition or that restoring fallback restores accuracy.

Only the same existing closed 60-second problem input was compared; no new test
sound was recorded or played. Raw candidate outputs stayed in isolated local
directories. Production ASR and existing software remained running.

| Profile | Inference seconds | CPU seconds | Segments / unique texts | Result |
| --- | ---: | ---: | ---: | --- |
| Existing two-thread fixed-temperature profile | 72.748 | 28.891 | 22 / 3 | One text repeated 20 times; suspect |
| Two threads, original temperature fallback | >180 | Not retained | No completed result | Bounded test stopped |
| Four threads, original temperature fallback | 131.646 | 78.016 | 17 / 8 | One text repeated 8 times; suspect |

The four-thread candidate reached temperature 1.0; its returned average log
probability was still below the existing -1.0 threshold (approximately -1.229).
The existing decoder can return a candidate after exhausting fallback attempts;
nonempty output alone must not approve it. VAD found 10 intervals totalling
19.232 seconds in that sample. This is not a case of VAD removing the entire
input. Low overall signal, background noise and model limitations remain possible
contributors; neither VAD nor decoder confidence establishes human ground truth.

The slower, still repetitive fallback candidate was not promoted to production.
The installed two-thread profile remains in place with the protective review gate
below. No threshold, beam width, model or input was weakened to obtain a pass.

## Local review gate

For future small-model results:

- Eight or more nonempty segments with at least 50% duplicate normalized texts
  and a text occurring at least four times require review. This is a conservative
  heuristic; genuine repeated speech can also require review.
- Returned segments still below the existing log-probability threshold or above
  the existing compression-ratio threshold also require review. Raw confidence
  metadata is retained instead of silently accepting exhausted decoding attempts.
- Suspect candidates are saved with `reviewRequired: true` only in local
  `state/ambient-review`. The worker returns `REVIEW_REQUIRED` before the formal
  transcript writer. Original audio remains retained under the existing failure
  handling; no suspect text is automatically added to the daily document.
- A receipt tied to the unchanged source fingerprint and policy prevents repeated
  inference of the same suspect input. It is not automatic approval or silence.
- Existing formal documents are not rewritten or removed. Retained review audio
  remains subject to the existing cache/disk safeguards; no history cleanup is
  added by this change.

The installed worker protocol rejected a pre-marked suspect sample in about
0.006 seconds after startup with zero inference CPU time. This is a review-cache
test, not an ASR speed measurement. Regression checks: 34 Node and 25 Python tests
passed, including retention, review-cache invalidation, threshold checks and
nonrepeated-text behavior.

The screen can miss hallucinations and can flag legitimate speech. Human accuracy
review, reliable real-time throughput and independent cloud delivery remain
unverified. The prior cloud 403 is not retried or bypassed; permissions are unchanged.
No new model, private transcript, recording, credential or device identifier is
included in this source update.
