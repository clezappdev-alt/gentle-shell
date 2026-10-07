import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	GENTLE_AI_DEV_BINARY_ENV,
	GENTLE_AI_DEV_BINARY_OPT_IN_ENV,
	gentleAiDevBinaryRegistrationPath,
	registerGentleAiDevBinaryOptIn,
	setGentleAiDevBinaryEnvironmentForTesting,
	unregisterGentleAiDevBinaryOptIn,
} from "../lib/gentle-ai-binary.ts";

// Loud surfacing for the dev-binary override: while an override is active,
// every diagnostic surface must say so, name the exact binary, its live
// version, and its content digest — the maintainer must never wonder which
// gentle-ai actually answered.

interface CommandRegistration {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function harness(): { pi: ExtensionAPI; commands: Map<string, CommandRegistration> } {
	const commands = new Map<string, CommandRegistration>();
	const pi = {
		on() {},
		registerCommand(name: string, registration: CommandRegistration) {
			commands.set(name, registration);
		},
		registerTool() {},
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

function contextFor(cwd: string, notifications: Array<{ message: string; severity: string }>): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string, severity: string) {
				notifications.push({ message, severity });
			},
		},
	} as unknown as ExtensionContext;
}

async function withDevOverride<T>(callback: (state: { devBinary: string; sha256: string; home: string }) => Promise<T>): Promise<T> {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	const bin = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-bin-"));
	const devBinary = join(bin, "gentle-ai");
	writeFileSync(devBinary, "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+surface'\n");
	chmodSync(devBinary, 0o755);
	const sha256 = createHash("sha256").update(readFileSync(devBinary)).digest("hex");
	setGentleAiDevBinaryEnvironmentForTesting({ env: { [GENTLE_AI_DEV_BINARY_ENV]: devBinary }, home });
	try {
		return await callback({ devBinary, sha256, home });
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
}

test("gentle:doctor and gentle:status surface the active dev-binary override loudly", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	try {
		await withDevOverride(async ({ devBinary, sha256 }) => {
			const { pi, commands } = harness();
			createGentleAiExtension({ nativeReviewCli: null })(pi);
			const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
			
			// Explicitly opt-in to dev-binary override usage for this test
			await registerGentleAiDevBinaryOptIn(true);
			
			const expected = `Gentle AI dev binary override active (unpinned, field-test only): ${devBinary} 9.9.9-dev+surface sha256:${sha256.slice(0, 16)}`;
			for (const command of ["gentle:doctor", "gentle:status"]) {
				const notifications: Array<{ message: string; severity: string }> = [];
				await commands.get(command)!.handler("", contextFor(cwd, notifications));
				const match = notifications.find(n => n.message.includes(expected));
				assert.ok(match, `Expected message not found in notifications: ${JSON.stringify(notifications)}`);
				assert.equal(match.severity, "warning", `${command}: expected warning severity`);
				const otherWarnOrFail = notifications.filter(n => n !== match && (n.message.startsWith("warn:") || n.message.startsWith("fail:")));
				assert.equal(otherWarnOrFail.length, 0, `${command}: unexpected additional warning/fail lines: ${JSON.stringify(otherWarnOrFail)}`);
			}
			
			// Clean up opt-in registration
			await unregisterGentleAiDevBinaryOptIn();
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("without an override the surfaces stay silent about dev binaries", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	setGentleAiDevBinaryEnvironmentForTesting({ env: {}, home });
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
		for (const command of ["gentle:doctor", "gentle:status"]) {
			const notifications: Array<{ message: string; severity: string }> = [];
			await commands.get(command)!.handler("", contextFor(cwd, notifications));
			assert.equal(notifications.length, 1, command);
			assert.doesNotMatch(notifications[0]!.message, /dev binary/i, command);
		}
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("an invalid override is surfaced as a failure, never silently ignored", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	setGentleAiDevBinaryEnvironmentForTesting({ env: { [GENTLE_AI_DEV_BINARY_ENV]: "/nonexistent/gentle-ai" }, home });
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
		const notifications: Array<{ message: string; severity: string }> = [];
		await commands.get("gentle:doctor")!.handler("", contextFor(cwd, notifications));
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /fail: Gentle AI dev binary override/);
		assert.match(notifications[0]!.message, new RegExp(GENTLE_AI_DEV_BINARY_ENV));
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("gentle:dev-binary registers, reports, and clears the persistent override", async () => {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	const bin = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-bin-"));
	const devBinary = join(bin, "gentle-ai");
	writeFileSync(devBinary, "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+register'\n");
	chmodSync(devBinary, 0o755);
	setGentleAiDevBinaryEnvironmentForTesting({ env: {}, home });
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
		const command = commands.get("gentle:dev-binary");
		assert.ok(command, "gentle:dev-binary command is registered");
		const registrationPath = gentleAiDevBinaryRegistrationPath({ env: {}, home });

		let notifications: Array<{ message: string; severity: string }> = [];
		await command!.handler("status", contextFor(cwd, notifications));
		assert.match(notifications[0]!.message, /no dev binary override/i);

		notifications = [];
		// Ensure opt-in is disabled (default) to see opted-out state
		await unregisterGentleAiDevBinaryOptIn(); // Clear any previous opt-in
		await command!.handler(devBinary, contextFor(cwd, notifications));
		assert.equal(existsSync(registrationPath), true);
		assert.match(notifications[0]!.message, /dev binary override registered but opt-in disabled/);
		assert.ok(notifications[0]!.message.includes(devBinary));
		
		// Now opt-in and verify it becomes active
		await registerGentleAiDevBinaryOptIn(true);
		notifications = [];
		await command!.handler(devBinary, contextFor(cwd, notifications));
		assert.equal(existsSync(registrationPath), true);
		assert.match(notifications[0]!.message, /dev binary override active \(unpinned, field-test only\)/);
		assert.ok(notifications[0]!.message.includes(devBinary));

		notifications = [];
		await command!.handler("relative/gentle-ai", contextFor(cwd, notifications));
		assert.equal(notifications[0]!.severity, "error");

		notifications = [];
		await command!.handler("off", contextFor(cwd, notifications));
		assert.equal(existsSync(registrationPath), false);
		assert.match(notifications[0]!.message, /removed|cleared/i);
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
});

test("session start announces the active override once, loudly", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	try {
		await withDevOverride(async ({ devBinary, sha256 }) => {
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
			const pi = {
				on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
					handlers.set(name, handler);
				},
				registerCommand() {},
				registerTool() {},
			} as unknown as ExtensionAPI;
			createGentleAiExtension({ nativeReviewCli: null })(pi);
			const sessionStart = handlers.get("session_start");
			assert.equal(typeof sessionStart, "function");
			const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
			
			// Explicitly opt-in to dev-binary override usage for this test
			await registerGentleAiDevBinaryOptIn(true);
			
			const notifications: Array<{ message: string; severity: string }> = [];
			await sessionStart!({}, contextFor(cwd, notifications));
			const expected = `Gentle AI dev binary override active (unpinned, field-test only): ${devBinary} 9.9.9-dev+surface sha256:${sha256.slice(0, 16)}`;
			const announcement = notifications.find((entry) => entry.message.includes(expected));
			assert.ok(announcement, JSON.stringify(notifications));
			assert.equal(announcement!.severity, "warning");
			
			// Clean up opt-in registration
			await unregisterGentleAiDevBinaryOptIn();
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

// The registration file is not always in charge. The opt-in environment
// variable wins unconditionally whenever it is present, so enable and disable
// can both be no-ops. The command must report the MEASURED state and name the
// deciding origin, never the state the operator merely requested.
test("gentle:dev-binary-mode reports the measured opt-in, never the requested one", async () => {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-mode-home-"));
	const { pi, commands } = harness();
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
	const command = commands.get("gentle:dev-binary-mode");
	assert.ok(command, "gentle:dev-binary-mode command is registered");

	// disable while the environment variable is enabling: the file it removes is
	// not in charge, so the gate stays enabled and the command must say so.
	setGentleAiDevBinaryEnvironmentForTesting({ env: { [GENTLE_AI_DEV_BINARY_OPT_IN_ENV]: "1" }, home });
	try {
		const notifications: Array<{ message: string; severity: string }> = [];
		await command!.handler("disable", contextFor(cwd, notifications));
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /opt-in: enabled/, "disable must report the measured state, not the requested one");
		assert.doesNotMatch(notifications[0]!.message, /opt-in: disabled/);
		assert.match(notifications[0]!.message, new RegExp(`decided by env ${GENTLE_AI_DEV_BINARY_OPT_IN_ENV}`), "the deciding origin must be named");
		assert.match(notifications[0]!.message, /takes precedence; unset it for this to take effect/, "a no-op must be actionable, never silent");
		assert.equal(notifications[0]!.severity, "warning");
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}

	// Symmetric case: enable while the environment variable is disabling.
	setGentleAiDevBinaryEnvironmentForTesting({ env: { [GENTLE_AI_DEV_BINARY_OPT_IN_ENV]: "0" }, home });
	try {
		const notifications: Array<{ message: string; severity: string }> = [];
		await command!.handler("enable", contextFor(cwd, notifications));
		assert.match(notifications[0]!.message, /opt-in: disabled/, "enable must report the measured state, not the requested one");
		assert.doesNotMatch(notifications[0]!.message, /opt-in: enabled/);
		assert.match(notifications[0]!.message, new RegExp(`decided by env ${GENTLE_AI_DEV_BINARY_OPT_IN_ENV}`));
		assert.match(notifications[0]!.message, /takes precedence; unset it for this to take effect/);
		assert.equal(notifications[0]!.severity, "info");
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}

	// With nothing in the environment, disable really disables and names the
	// registration file it acted on.
	setGentleAiDevBinaryEnvironmentForTesting({ env: {}, home });
	try {
		const notifications: Array<{ message: string; severity: string }> = [];
		await command!.handler("disable", contextFor(cwd, notifications));
		assert.match(notifications[0]!.message, /opt-in: disabled \(decided by registration/);
		assert.doesNotMatch(notifications[0]!.message, /takes precedence/, "no override in play must not claim one");

		// And enable still reports the truth when it does take effect.
		const enabled: Array<{ message: string; severity: string }> = [];
		await command!.handler("enable", contextFor(cwd, enabled));
		assert.match(enabled[0]!.message, /opt-in: enabled \(decided by registration/);
		assert.equal(enabled[0]!.severity, "warning");
		await unregisterGentleAiDevBinaryOptIn();
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
});

test("opted-out override is surfaced as a warning and is never executed", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	const bin = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-bin-"));
	const devBinary = join(bin, "gentle-ai");
	// Canary: this script leaves a marker behind if anything executes it, so the
	// assertion is about real execution and not just about an absent version.
	const executed = join(bin, "executed");
	writeFileSync(devBinary, `#!/bin/sh\ntouch '${executed}'\necho 'gentle-ai 9.9.9-dev+surface'\n`);
	chmodSync(devBinary, 0o755);
	const sha256 = createHash("sha256").update(readFileSync(devBinary)).digest("hex");
	setGentleAiDevBinaryEnvironmentForTesting({ env: { [GENTLE_AI_DEV_BINARY_ENV]: devBinary }, home });
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
		
		// Ensure opt-in is disabled (should be by default, but let's be explicit)
		await unregisterGentleAiDevBinaryOptIn();
		
		const expected = `Gentle AI dev binary override registered but opt-in disabled: ${devBinary} sha256:${sha256.slice(0, 16)}. Not executed while opt-in is disabled. Run \`gentle:dev-binary-mode enable\` to opt in.`;
		for (const command of ["gentle:doctor", "gentle:status"]) {
			const notifications: Array<{ message: string; severity: string }> = [];
			await commands.get(command)!.handler("", contextFor(cwd, notifications));
			const match = notifications.find(n => n.message.includes(expected));
			assert.ok(match, `Expected message not found in notifications: ${JSON.stringify(notifications)}`);
			assert.equal(match.severity, "warning", `${command}: expected warning severity`);
			assert.doesNotMatch(match.message, /9\.9\.9-dev\+surface/, `${command}: the opted-out line must not carry a version obtained by execution`);
			const otherWarnOrFail = notifications.filter(n => n !== match && (n.message.startsWith("warn:") || n.message.startsWith("fail:")));
			assert.equal(otherWarnOrFail.length, 0, `${command}: unexpected additional warning/fail lines: ${JSON.stringify(otherWarnOrFail)}`);
			// doctor and status are recovery tools: they must never run the very
			// binary the operator opted out of.
			assert.equal(existsSync(executed), false, `${command}: executed the opted-out dev binary`);
		}
		
		// Test that gentle:dev-binary status also shows the opted-out state
		const commandNotifications: Array<{ message: string; severity: string }> = [];
		await commands.get("gentle:dev-binary")!.handler("status", contextFor(cwd, commandNotifications));
		const commandMatch = commandNotifications.find(n => n.message.includes(expected));
		assert.ok(commandMatch, `Expected message not found in command notifications: ${JSON.stringify(commandNotifications)}`);
		assert.equal(commandMatch.severity, "warning", `gentle:dev-binary status: expected warning severity`);
		assert.doesNotMatch(commandMatch.message, /9\.9\.9-dev\+surface/, "gentle:dev-binary status: must not carry a version obtained by execution");
		const otherCmdWarnOrFail = commandNotifications.filter(n => n !== commandMatch && (n.message.startsWith("warn:") || n.message.startsWith("fail:")));
		assert.equal(otherCmdWarnOrFail.length, 0, `gentle:dev-binary status: unexpected additional warning/fail lines: ${JSON.stringify(otherCmdWarnOrFail)}`);
		assert.equal(existsSync(executed), false, "gentle:dev-binary status: executed the opted-out dev binary");
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});
