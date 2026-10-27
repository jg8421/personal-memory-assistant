# Windows ambient capture and offline ASR: validation notes

Comparison baseline: `v0.4.0` (`546fcf70d9593db5d2fafbc757c83441f649ff17`).
The integration also includes upstream Qwen context changes through
`fdc57d18e4445b6d64860e7f8e646b459419dbc8`.

## Changes since v0.4.0

- Opt-in continuous microphone capture, hidden tray supervision, segmentation,
  pause/resume, disk reserve and recorder recovery. This captures microphone
  input; it does not add system-output loopback recording.
- Offline timestamped JSON and daily text. Audio cleanup requires a successful
  verified transcript write, or a compact local silence receipt with fsync and
  readback. Failed input remains available for retry. Existing historical audio
  and documents are not migration or cleanup targets.
- Silent segments do not create empty transcript documents in the sync folder.
  A rebuild with no speech preserves an existing daily document.
- Per-file failure tracking uses file identity, size and modification time,
  bounded exponential retry and batches; recent closed speech gets a turn during
  backfill. A bad head file does not block unrelated newer input.
- Explicit loaded-model/device reporting, offline Qwen3-ASR support, VAD spans,
  bounded nearby-speech merging and optional locally supplied verified vocabulary.
  Invalid vocabulary updates retain the last valid context. Vocabulary is not
  automatically inferred from private documents.
- NVIDIA GPU handling and CPU recovery remain supported where the installed
  runtime and actual model support them. Experimental Intel XPU selection is
  explicit and verifies both availability and model parameter placement. It
  rejects silent CPU placement. CUDA configuration is not an Intel GPU backend.
- A pinned DirectShow input ID bypasses full device enumeration and does not
  implicitly follow the Windows communications default. Optional fallback must
  be explicitly enabled. Configure meeting applications separately; some ignore
  the Windows communications role, and USB disconnection behavior is app-specific.
- Optional audio quiet hours use a configured IANA timezone. Desktop activity is
  independent of the audio quiet interval. Optional power monitoring preserves
  separate audio and desktop decisions; the supplied audio energy policy is
  AC-only and pauses in saver/efficiency modes. Review that stricter policy before
  enabling it if recording on battery with an open lid is desired.
- Interrupted PCM recovery preserves a verified original before header repair;
  fresh active input is not repaired. Windows state replacement retries transient
  sharing conflicts without changing permissions or substituting a partial write.

## What has actually been checked

Automated tests cover retention/readback, silence, historical-document retention,
queue fairness/retries, explicit XPU placement, vocabulary handling, microphone
pinning, quiet-hour boundaries, power-state replacement gaps, PCM recovery and
Windows atomic-write sharing conflicts. Counts and live benchmark results belong
in the release body after the final run.

In one Windows Intel Arc B390 deployment, PyTorch 2.14.1+xpu detected the GPU,
executed FP16 operations and loaded Qwen parameters on XPU. One real 60-second
sample produced three nonempty segments (52 characters), but the cold reference
took 436 seconds. That is not a real-time performance pass. A subsequent run
loaded in 84.5 seconds and completed an explicitly synthetic 45.7-second warmup;
its first real 60-second input then exceeded the 180-second test bound. Production
model switching remains blocked on acceptable measured throughput.

A clean default-priority reference was subsequently completed with all 707
parameters in FP16 on XPU, eval enabled, an explicit inference-mode context,
SDPA, and the unchanged 1024-token generation cap. The same 60-second sample
took 173.923 seconds (RTF 2.899), returning the same three segments/52 characters.
Observed process RSS peaked at 9.531 GB; the XPU allocator peak was 4.704 GB.
These are separate counters, not additive physical-memory measurements.

A two-thread default-priority CPU/FP32 comparison returned the first 60-second
sample in 91.630 seconds (RTF 1.527), with three nonempty segments/52 characters
and an observed RSS peak of 13.154 GB. The second 60-second sample exceeded the
180-second inference bound and exited through the diagnostic hard timeout;
it produced no completed transcript. Both samples contain real speech, but the
two-nonempty-sample acceptance gate was not passed. No production model switch
is justified by these results. The previous working model remains in place.

Startup diagnostics found a large difference between lowering process priority
before native imports and retaining the inherited default during initialization:
the default-priority minimal import completed in 18.7 seconds and CPU/XPU tensor
reads succeeded. The integration loads and warms dependencies before lowering
inference priority, with OMP/MKL limited to two threads. Synthetic warmup output
is discarded and never counts as real-speech acceptance. These observations do
not establish that Windows security blocked execution; a thread reported as
Suspended does not by itself identify its cause. A read-only job query reported
no enabled CPU-rate cap or process power-throttling mask in the tested launcher.

The fixed built-in microphone produced a valid 9.969-second bounded recording.
Following recorder recovery, two new closed PCM16/16kHz/mono files measured
54.799 and 51 seconds, and later files continued growing. These observations do
not establish lossless 60-second segmentation. The configured overnight pause
was observed after the 02:00 boundary with no owned recorder process. Actual
09:00 resume, concurrent conference use, a complete 24-hour soak and universal
recognition accuracy have not been established by these checks.

Local transcript readback, local OneDrive writes, independent cloud readback,
real microphone capture, login recovery and 24-hour stability are separate
acceptance steps. Do not label one as evidence for the others.

## Upgrade boundaries

Back up source and configuration. Merge device-specific power, quiet-hours and
PCM recovery changes; do not overwrite them with a different computer's config.
Close the current input safely before replacing a supervisor. A changed Python
environment requires a new transcription object/supervisor, not merely killing
its Python child. Keep the prior working model/configuration for rollback.

Use only locally present complete model files, strict offline inference and a
device-compatible isolated runtime. Model downloads, cloud placeholders, runtime
installation and network routing require explicit operator decisions. The
optional `prepare-qwen-runtime.py` only defers qwen-asr 0.0.6's unused Japanese
alignment import; it downloads nothing and preserves the original vendor file.
No model files, personal paths/device IDs, transcripts, audio, tokens or private
runtime settings are included in this source release. Android APK changes are
outside this Windows update.

File-based workers retain the deployment's PCM compatibility fix: closed
PCM16/mono/16kHz WAV input is read directly, and other configured input is decoded
by an existing FFmpeg process with hidden, bounded execution. This avoids relying
on the incompatible PyAV metadata API without changing or deleting the input.
