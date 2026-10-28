# Release notes

## Windows morning-recovery correction — 2026-10-28

- Keep capture initialization and the power heartbeat responsive under inherited background scheduling; allow an explicit device-local normal inference priority while retaining the two-thread CPU bound.
- Initialize bundled offline VAD before inference scheduling. Defer prolonged Windows state snapshot sharing conflicts without terminating live capture, changing permissions, or replacing a partial snapshot.
- Record the initially failed 09:00 recovery and subsequent repair honestly. Two existing-speech small-model tests produced nonempty isolated documents but were slower than real time, and one showed substantial repetition. Cloud arrival, transcript accuracy, another morning boundary and 24-hour stability remain unverified.
- See [measured recovery and remaining limits](docs/windows-morning-recovery-validation.md). Regression checks: 34 Node and 21 Python tests passed. Historical data and the existing production model remain preserved.

## v0.5.0 — 2026-10-28

Compared with v0.4.0, this includes offline ambient transcription, verified text retention, compact local silence receipts, queue retry/fairness, loaded-model status, NVIDIA recovery, Qwen3-ASR-1.7B and upstream verified vocabulary/nearby-speech context. It also adds explicit experimental Intel XPU placement checks, pinned microphone input, optional timezone quiet hours and power monitoring, interrupted PCM preservation/recovery, and Windows state-file sharing-conflict retries.

Empty rebuilds preserve existing daily documents. Runtime/model/configuration changes remain opt-in and device-local. Existing recordings, historical transcripts, private vocabulary, credentials and model weights are excluded from the source release. Android APK changes are outside this update.

See [validation and upgrade boundaries](docs/release-0.5-validation.md) for the measured checks and outstanding acceptance steps. A successful Intel tensor operation does not establish Qwen inference throughput. Actual 09:00 resume, simultaneous meeting behavior and 24-hour stability remain separate validations.


## Unreleased — 2026-10-24

- Added opt-in Windows microphone capture managed by the existing tray, with continuous segmentation, pause/resume, input recovery and low-disk protection.
- Added offline transcript-only retention using an existing local faster-whisper model. Timestamped segment JSON and daily text are verified on disk before deleting each audio input; failed jobs retain their audio for retry.
- Kept speech recognition separate from capture so long jobs do not block microphone pause and recovery. CPU transcription uses two threads and background priority; no audio upload or automatic model download is performed.
- Added an inactive generic configuration example, optional Python requirements, retention tests and ignore rules for runtime settings, audio, transcripts and model caches.
- Windows-only source update. The existing Android version and packaged APK are unchanged. Real conference calls and a full 24-hour soak remain outside the automated test coverage.

## v0.4.0 — 2026-10-01

- Added an HTTPS upload-only gateway for Android-to-Windows synchronization across networks without an additional Android VPN or Microsoft app authorization. HTTPS routing must be configured by the operator; Windows must remain awake and connected.
- Added a separate upload token, loopback-only listener, bounded Android batches, request limits, and health-only status. Search, memory retrieval and deletion are unavailable through the public listener.
- Fixed legacy Android batch acknowledgement compatibility: the gateway returns counts plus identifiers from the submitted batch, never stored memory contents. Retried records retain source-ID deduplication.
- Fixed Microsoft connection-button feedback: nearby status, immediate Client ID validation, and visible failure dialogs.
- Added hidden Windows user-login tunnel startup and connector restart monitoring. Existing VPN settings and unrelated domain routes are not changed.
- Removed deployment-specific names, domains, organization/account identifiers and absolute user paths from distributable source and APK. OneDrive tenant and destination are configurable; hostname and GitHub owner are supplied by the operator.
- Verified an actual phone HTTPS upload into the Windows store and a subsequent OneDrive cloud file update in the test deployment. No claim of exhaustive capture, guaranteed background execution, measured battery impact, or a completed mobile-network handover test.

### Upgrade

Install the APK as an update only if its signing certificate matches your installation. Runtime preferences and queues remain device-local. Deploy the updated Windows gateway with the service. An existing computer-mediated HTTPS configuration does not require Microsoft Client ID configuration; leave direct Graph mode disabled for that workflow.

### Privacy

No real user memories, runtime tokens, OAuth credentials, signing private keys or operational tunnel configuration are included. Android notifications and accessibility are opt-in, editable/password fields and recognized sensitive pages are filtered, and capture can be paused. Source IDs and filtered metadata are still personal data when generated during actual use: keep your runtime storage private.
