# Portkey gateway and the privacy-tier trade-off

> Audience: operators + maintainers. Scope: the optional Portkey gateway (PRD-063). Status: shipped with 063a/063b.

## The trade-off, stated plainly

Honeycomb's inference router normally enforces a per-provider PRIVACY TIER. An operator can declare a floor (for
example `private` or `restricted`) in `agent.yaml` so captured-trace content (raw prompts, tool calls, model
responses) is never routed to a provider below that floor.

When the optional Portkey gateway is turned ON (`portkey.enabled`), inference is routed through Portkey, which
ABSTRACTS the underlying provider. Honeycomb can no longer reason about which downstream model ultimately serves the
request, so the per-provider privacy-tier gate is bypassed: the synthetic Portkey workload is admitted at the
`public` tier regardless of the operator's configured floor.

This is intentional and is the whole point of a gateway (you configure routing, fallbacks, and guardrails once in
Portkey). It is recorded here so the trade-off is a CONSCIOUS operator decision, not a silent regression.

## What this means for you

- Enabling Portkey is an explicit opt-in. You are pointing your own `PORTKEY_API_KEY` at a gateway YOU configured.
- While Portkey is on, the `agent.yaml` privacy floor does not constrain where your trace content goes. Control that
  in your Portkey config (provider selection, regional routing, guardrails, redaction) instead.
- If you require Honeycomb-side enforcement of a privacy floor, do NOT enable Portkey, or keep
  `portkey.fallbackToProvider` off and use the per-provider path whose tier the router enforces.

## Where it lives in code

- The synthetic Portkey target is built in `src/daemon/runtime/inference/model-client-factory.ts`
  (`buildPortkeyConfig`), which stamps `privacyTier: "public"` so the router gate always admits it.
- The toggle + key live in the Settings page (PRD-063a); routing is in `transport-portkey.ts` + the factory
  supersession (PRD-063b).

## Future option (not built)

If Honeycomb-side enforcement is ever wanted, the correct design is an EXPLICIT operator acknowledgment ("I accept
routing at the public tier when Portkey is on"), not a silent fail-closed gate (which would disable Portkey for any
operator who declared a non-public floor). That would be its own PRD. See PRD-063b open notes and the
2026-06-27 security audit in the PRD-063 reports folder.
