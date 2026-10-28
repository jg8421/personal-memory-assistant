# Personal Memory Assistant v0.5.0: Windows ambient capture and offline ASR

Comparison baseline: **v0.4.0**, commit `546fcf70d9593db5d2fafbc757c83441f649ff17`.
Upstream Qwen context changes through `fdc57d1` are preserved.

Follow-up: [measured Windows morning-recovery correction](../docs/windows-morning-recovery-validation.md)
records the initial failed unattended start, scheduling/state-sharing fixes,
isolated small-model throughput and repetition limits. The original 09:00 start
did not pass naturally; local recovery does not establish cloud delivery or
recognition accuracy.

## Changes since the previous formal release

- Opt-in hidden Windows microphone supervision, continuous segmentation,
  pause/resume, disk reserve, input recovery and tray status.
- Explicit microphone pinning with controlled fallback. Environment input can
  stay on the built-in microphone while meeting applications use a separate
  communications input. Application-specific meeting settings remain relevant.
- Offline timestamped segment JSON and daily text, verified local writes before
  authorized cache cleanup, and retained input on failure. No historical audio
  migration, bulk reprocessing or deletion is part of this update.
- Silence produces a compact local fsync/readback receipt instead of empty sync
  documents. Empty rebuilds preserve existing historical daily documents.
- Per-file retry/backoff and recent-input fairness prevent a bad head file from
  blocking newer closed recordings.
- Explicit loaded-model/device status, NVIDIA GPU/CPU recovery, Qwen3-ASR-1.7B,
  VAD interval timestamps, nearby-speech merging and optional local verified
  recognition context. Invalid context updates retain the last valid version.
- Experimental Intel XPU selection checks actual availability and parameter
  placement; it rejects silent CPU placement. It remains unsuitable for real-time
  use in the measured Windows configuration below.
- Optional timezone quiet hours and separate audio/desktop power decisions.
  Desktop activity does not inherit the audio quiet interval. The supplied audio
  energy policy is stricter than the desktop battery/lid policy; review it before
  enabling it on a device.
- Interrupted PCM recovery preserves an original before repair. Direct PCM and
  bounded hidden FFmpeg decoding preserve the existing PyAV compatibility fix.
- Windows state replacement retries transient sharing conflicts. Owned ASR
  process-tree teardown covers pause and job timeout, preventing orphan workers.
- Native/model/lazy-runtime initialization and an explicitly synthetic warmup
  complete before inference scheduling is lowered. Synthetic output is discarded.
- Runtime configuration, private context, local models and captured data are
  excluded. Existing Android source/APK behavior is unchanged by this Windows
  update.

## Validation and limitations

- Automated regression: **34 Node tests and 21 Python tests passed**.
- Intel Arc B390: actual XPU operations and model placement passed. With eval,
  inference mode, FP16 and the full 1024-token cap, one real 60-second input took
  **173.923 seconds**, returning three nonempty segments/52 characters. This fails
  real-time throughput. The earlier cold reference took approximately 436 seconds.
- CPU/FP32, two threads: the same first input took **91.630 seconds**; the second
  60-second input exceeded the **180-second bound** without a completed result.
- Observed RSS peaks were approximately **9.53 GB on XPU** and **13.15 GB on the
  first CPU sample**. XPU allocator counters describe shared GPU memory separately.
- Existing production model/configuration was retained. This is not a claim of a
  successfully deployed real-time Intel Qwen profile.
- Overnight pause was observed after the configured boundary with no recorder.
  Actual morning resume, simultaneous conference use, login recovery, independent
  cloud readback and a full 24-hour soak remain separate acceptance steps.

No model, generation cap, or audio content was reduced to obtain a passing
benchmark. Sample-level text consistency is not a human accuracy evaluation.
See [full validation and upgrade boundaries](../docs/release-0.5-validation.md).
