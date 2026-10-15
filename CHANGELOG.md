# Changelog

## 0.2.0 — Bounded rotation
- Allow wrapping to recovered accounts after cooldown.
- Cap automatic switches per user task (8 by default, configurable via `/codex-auto max <1-100>`).
- Show current switch budget in `/codex-auto status`.
- Add regression tests for wraparound, limits, and budget resets.

## 0.1.1 — Compatibility fix
- Replace inaccessible `AuthStorage.create()` with the exported credential reader.

## 0.1.0 — Initial prototype
- Quota error detection and automatic continuation.
