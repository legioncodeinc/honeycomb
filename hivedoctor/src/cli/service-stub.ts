/**
 * The `install-service` / `uninstall-service` delegation seam (PRD-064f Scope).
 *
 * OS-service registration is PRD-064b, a LATER wave. This module is deliberately NOT an
 * implementation of service registration - it is the seam the CLI calls today. When the
 * 064b service module is wired in (via {@link ServiceModule}, injected by the composition
 * root), the command delegates to it; when it is absent (the default in this wave), the
 * command prints an honest "not yet available" message and exits cleanly.
 *
 * This keeps the 064b boundary crisp: there is ZERO service-registration code here (no
 * `launchctl` / `schtasks` / `systemctl` shell-outs), only the dispatch stub that 064b
 * will satisfy. Built-ins only; pure aside from delegating to the injected module.
 */

/** The 064b service module the composition root injects when that wave lands. Optional today. */
export interface ServiceModule {
	/** Register HiveDoctor as an OS service. Returns a human-readable result line. */
	install(): Promise<string>;
	/** Unregister the HiveDoctor OS service. Returns a human-readable result line. */
	uninstall(): Promise<string>;
}

/** The honest message printed when 064b is not yet wired in. */
export const SERVICE_NOT_AVAILABLE =
	"Service registration is not yet available (PRD-064b). " +
	"For now, HiveDoctor runs when you start it manually.";
