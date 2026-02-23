# Requirements — openclaw-issue-evo10

<!-- PROVENANCE: source=api url=https://api.github.com/repos/openclaw/openclaw/issues fetched=2026-02-22T16:50:43Z trust=untrusted -->

## Candidate bug issues screened

- https://github.com/openclaw/openclaw/issues/23590
  - Title: [Bug]: Images in session history re-processed on every turn instead of being cached
  - Why selected: Reproducible with clear logs, impact is concrete (latency/noise/cost), and fix scope is local to image sanitization pipeline.
- https://github.com/openclaw/openclaw/issues/23715
  - Title: [Bug]: 5x API costs due to ineffective prompt caching
  - Why selected: Impact is high and the issue proposes a concrete, low-risk mitigation (instance-specific stable system prompt prefix).
- https://github.com/openclaw/openclaw/issues/23622
  - Title: [Bug]: edit tool's "path" parameter gets truncated, causing JSON parse error
  - Why not in this run: Multi-provider/tool-call parser path is broader and requires a dedicated repro harness; deferred to avoid mixing high-risk parser changes into this 10-round scope.

## Final scope for this 10-round run

1. Fix #23590 by adding deterministic in-process caching for image resize sanitization results, with bounded LRU behavior and tests.
2. Fix #23715 by making the opening system-prompt line stable-per-installation (not globally identical), with tests to confirm stability and variation.
3. Execute 10 full v5 rounds with checkpointing, review artifacts, compare, fix-plan, merge/test gate, and round summaries.
<!-- /PROVENANCE -->
