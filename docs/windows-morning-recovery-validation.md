# Windows morning recovery: measured result and remaining limits

This is a source-fix follow-up to the v0.5.0 integration, not a claim that the
first unattended morning recovery succeeded or that recognition quality passed.

## Initial failure and application-level correction

In the observed deployment, the 02:00-09:00 Asia/Shanghai microphone quiet rule
ended as configured and capture attempted to start at 09:00:02. No new audio was
initially produced. Inherited background scheduling delayed native input and ASR
initialization. Delayed power-heartbeat updates caused conservative pauses, and a
prolonged Windows state-file replacement conflict could terminate the supervisor.
The existing watchdog then restarted it. These are failures followed by recovery,
not a clean natural-resume pass.

The follow-up keeps the capture supervisor and power-heartbeat helper at normal
priority, initializes the already installed offline VAD before inference scheduling,
and defers a conflicting state snapshot to a later progress/tick without replacing
permissions or publishing a partial snapshot. Other write errors remain visible.
The local profile can explicitly select normal inference priority while retaining
two CPU threads. The default generic inference priority remains below normal.
No Windows power/security policy, microphone fallback, recognition threshold or
model weight was changed to obtain these results.

Five consecutive approximately 60-second segments starting at 09:12:30 through
09:16:30 closed and produced verified local no-recognized-speech receipts. Later
natural input also produced nonempty local JSON and daily text. An already-written
five-second input sample had nonzero amplitude (RMS about -50.8 dBFS), no clipping,
and approximately 1.95 seconds of VAD candidate speech. VAD output alone does not
establish that a human spoke or that recognition was accurate.

## Installed small-model worker: isolated existing-speech test

The exact installed faster-whisper-small worker, UTF-8/unbuffered launch flags,
offline model path and two-thread normal-priority profile were tested against two
existing closed 60-second speech samples. Outputs and verified daily-document
writes were isolated from production and cloud folders; test inputs were retained.
The first harness attempt omitted the production UTF-8 launch flags and was
discarded after its output reader failed. The corrected attempt completed:

| Sample | Inference seconds | Real-time factor | Segments | Characters | Unique segment texts |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 67.366 | 1.123 | 7 | 47 | 7 |
| 2 | 72.748 | 1.212 | 22 | 68 | 3 |

Startup including model/VAD initialization took 17.312 seconds. Observed aggregate
peak worker-tree RSS was approximately 732 MB. Both outputs were Chinese and
nonempty, with zero blank segments. The second output contained substantial
repetition (22 segments but only three unique texts); nonempty output is therefore
not recognition-quality acceptance. Both measured inference times exceeded input
duration. Live production ASR and the existing sync client were running during
this check, so this is a loaded-machine observation, not an idle performance claim.

## Verification boundaries

- Regression checks: 34 Node tests and 21 Python tests passed, including prolonged
  state sharing conflict, preservation of the previous snapshot and explicit
  access-denial behavior.
- The production model remains faster-whisper-small. Qwen/Intel XPU remains
  experimental and was not enabled by this correction.
- Local text writes were verified independently of cloud delivery. Exact cloud
  readback was refused by the connector; no sharing permissions or credentials
  were changed. Independent cloud arrival remains unverified.
- Empty historical files remain retained for diagnosis; this update does not
  authorize deleting history or bulk-processing an old audio backlog.
- A second real morning boundary, login recovery, simultaneous conference use,
  human transcript accuracy review and 24-hour stability remain unverified.

No private recording, transcript content, device identifier, personal path,
credential or model weight is included in this report or source update.
