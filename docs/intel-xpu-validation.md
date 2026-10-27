# Intel XPU deployment boundary

Choose the backend from the actual hardware: CUDA for a supported NVIDIA runtime,
explicit experimental `device: "xpu"` for an available Intel XPU runtime, and CPU
only after measuring throughput. Check `torch.xpu.is_available()` and actual
parameter placement for Intel. The worker's `auto` GPU selection targets CUDA;
Intel deployment needs the explicit XPU setting.

The measured Arc B390 profile remains experimental. A real 60-second sample took
173.923 seconds with default scheduling, FP16, eval, inference mode and the full
1024-token generation cap. Two-thread CPU/FP32 took 91.630 seconds for the first
sample; the second exceeded the 180-second bound. Keep the established production
model/configuration for this deployment. This is not a real-time rollout pass.

Initialize native libraries, the local model and lazy audio/generation paths before
lowering inference priority. OMP/MKL are capped at two threads. Synthetic warmup
output is discarded; real input keeps the full generation cap. Preserve direct
PCM decoding, original audio, power rules and existing FFmpeg fallback when merging
device-specific fixes. Actual morning resume, login recovery, conference use and
24-hour stability remain separate checks.

See [full validation](release-0.5-validation.md) and
[changes since v0.4.0](../releases/WINDOWS-ASR-CANDIDATE-NOTES.md).
