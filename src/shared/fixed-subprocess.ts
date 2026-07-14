/** A shell-free executable plus argv selected for the current platform. */
export interface FixedSubprocessInvocation {
	readonly file: string;
	readonly args: readonly string[];
}

/**
 * Select a direct executable on POSIX or a fixed `cmd.exe /d /s /c` command on Windows.
 * Production callers supply compile-time constant Windows commands; the invocation always uses
 * `shell:false`, so no user-derived argument is reparsed by a shell.
 */
export function fixedSubprocessInvocation(
	platform: NodeJS.Platform,
	directFile: string,
	directArgs: readonly string[],
	windowsCommand: string,
): FixedSubprocessInvocation {
	return platform === "win32"
		? { file: "cmd.exe", args: ["/d", "/s", "/c", windowsCommand] }
		: { file: directFile, args: directArgs };
}
