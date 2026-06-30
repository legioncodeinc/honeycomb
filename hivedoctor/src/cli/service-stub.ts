/**
 * The `install-service` / `uninstall-service` delegation seam (PRD-064f Scope).
 *
 * OS-service registration is PRD-064b. The 064b service module (src/service/index.ts) is now
 * WIRED IN by the composition root (cli/index.ts injects the real {@link ServiceModule} into
 * {@link CliDeps.serviceModule}); this seam still owns the contract the CLI's service commands
 * call. When the module is present, the command delegates to it and maps the {@link ServiceResult}
 * to an exit code (zero on `ok`, non-zero otherwise - IRD-192 AC-6); when it is absent, the
 * command prints an honest "not yet available" message and exits cleanly.
 *
 * This keeps the 064b boundary crisp: there is ZERO service-registration code here (no
 * `launchctl` / `schtasks` / `systemctl` shell-outs), only the contract the real module under
 * src/service satisfies. Built-ins only; pure aside from delegating to the injected module.
 */

/**
 * A structured install/uninstall outcome. Replaces the string-only return: a manager-command
 * failure (e.g. `schtasks /Create` rejecting the XML) MUST surface as `ok: false` so the CLI can
 * map it to a non-zero exit (IRD-192 AC-6). The never-throws contract is unchanged - the service
 * module maps every failure to a `ServiceResult`, never a thrown stack.
 */
export interface ServiceResult {
	/** True when the OS service manager accepted the unit (registered + started). */
	readonly ok: boolean;
	/** Human-readable line for the CLI to print (success detail, or the failure reason). */
	readonly message: string;
}

/** The 064b service module the composition root injects. Optional on {@link CliDeps}. */
export interface ServiceModule {
	/** Register HiveDoctor as an OS service. Returns a structured outcome for exit-code mapping. */
	install(): Promise<ServiceResult>;
	/** Unregister the HiveDoctor OS service. Returns a structured outcome for exit-code mapping. */
	uninstall(): Promise<ServiceResult>;
}

/** The honest message printed when 064b is not yet wired in. */
export const SERVICE_NOT_AVAILABLE =
	"Service registration is not yet available (PRD-064b). " +
	"For now, HiveDoctor runs when you start it manually.";
