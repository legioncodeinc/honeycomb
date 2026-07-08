# Changelog

## v0.6.2 — 2026-07-08

Adds an internal diagnostic log (enabled via HONEYCOMB_DEBUG_WAKE) that records which requests wake or reset the daemon's hibernation idle timer, to help troubleshoot unexpected wake-ups.

## v0.6.1 — 2026-07-06

Fixed the dashboard's harness activity endpoint to no longer show under-reported turn counts caused by stale DeepLake read replicas, by polling and taking the highest observed value.

