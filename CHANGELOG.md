# Release notes

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
