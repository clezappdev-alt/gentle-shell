import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	GENTLE_AI_DEV_BINARY_ENV,
	GENTLE_AI_DEV_BINARY_OPT_IN_ENV,
	GENTLE_AI_DEV_BINARY_OVERRIDE_INVALID_CODE,
	GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA,
	GentleAiDevBinaryOptInError,
	GentleAiDevBinaryOverrideError,
	PackageLocalGentleAiBinaryMissingError,
	gentleAiDevBinaryRegistrationPath,
	registerGentleAiDevBinary,
	resolveGentleAiBinary,
	resolveGentleAiDevBinaryOptIn,
	resolveGentleAiDevBinaryOverride,
	unregisterGentleAiDevBinary,
	type GentleAiDevBinaryEnvironment,
} from "../lib/gentle-ai-binary.ts";

const PLATFORM = "linux";

async function scratch(prefix: string): Promise<string> {
	return await mkdtemp(join(tmpdir(), prefix));
}

function writeDevBinary(directory: string, contents = "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+field'\n"): string {
	const path = join(directory, "gentle-ai");
	writeFileSync(path, contents);
	chmodSync(path, 0o755);
	return path;
}

function environment(home: string, env: Record<string, string | undefined> = {}): GentleAiDevBinaryEnvironment {
	return { env, home };
}

function registrationDocument(path: string): string {
	return `${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA, path })}\n`;
}

function writeRegistration(home: string, contents: string): string {
	const path = gentleAiDevBinaryRegistrationPath(environment(home));
	mkdirSync(join(home, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(path, contents);
	return path;
}

const isOverrideError = (origin: string | RegExp) => (error: unknown): boolean =>
	error instanceof GentleAiDevBinaryOverrideError
	&& error.code === GENTLE_AI_DEV_BINARY_OVERRIDE_INVALID_CODE
	&& (typeof origin === "string" ? error.message.includes(origin) : origin.test(error.message));

test("the explicit env override resolves a verified dev binary and never changes the pinned path", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	const devBinary = writeDevBinary(bin);
	const env = environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: devBinary });

	const override = resolveGentleAiDevBinaryOverride(env, PLATFORM);
	assert.equal(override?.source, "env");
	assert.equal(override?.path, devBinary);
	assert.match(override?.sha256 ?? "", /^[0-9a-f]{64}$/);
	// The override is only ever used once opt-in is enabled.
	const optedIn = environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: devBinary, [GENTLE_AI_DEV_BINARY_OPT_IN_ENV]: "1" });
	assert.equal(resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, optedIn), devBinary);

	const pinnedEnvironment = environment(home);
	assert.equal(resolveGentleAiDevBinaryOverride(pinnedEnvironment, PLATFORM), undefined);
	assert.throws(
		() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, pinnedEnvironment),
		PackageLocalGentleAiBinaryMissingError,
	);
});

test("a registration is strict, env wins, and unregister restores the pinned resolver", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const registeredDirectory = await scratch("gentle-pi-dev-bin-");
	const envDirectory = await scratch("gentle-pi-dev-env-");
	const registered = writeDevBinary(registeredDirectory);
	const envBinary = writeDevBinary(envDirectory, "#!/bin/sh\necho 'gentle-ai 9.9.10-dev'\n");
	const registeredResult = registerGentleAiDevBinary(registered, environment(home), PLATFORM);

	assert.equal(readFileSync(registeredResult.registrationPath, "utf8"), registrationDocument(registered));
	assert.equal(resolveGentleAiDevBinaryOverride(environment(home), PLATFORM)?.path, registered);
	assert.equal(resolveGentleAiDevBinaryOverride(environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: envBinary }), PLATFORM)?.path, envBinary);
	assert.equal(unregisterGentleAiDevBinary(environment(home)), true);
	assert.equal(resolveGentleAiDevBinaryOverride(environment(home), PLATFORM), undefined);
	assert.equal(unregisterGentleAiDevBinary(environment(home)), false);
});

test("invalid override sources fail closed instead of silently falling back to the pin", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	const devBinary = writeDevBinary(bin);
	const symlinked = join(bin, "gentle-ai-link");
	symlinkSync(devBinary, symlinked);
	const nonExecutable = join(bin, "gentle-ai-noexec");
	writeFileSync(nonExecutable, "#!/bin/sh\n");
	chmodSync(nonExecutable, 0o644);

	for (const value of ["relative/gentle-ai", symlinked, nonExecutable, join(bin, "missing-gentle-ai")]) {
		const env = environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: value });
		assert.throws(() => resolveGentleAiDevBinaryOverride(env, PLATFORM), isOverrideError(GENTLE_AI_DEV_BINARY_ENV), value);
		// Fail-closed is asserted in the opted-in state; opt-out is a kill switch
		// that skips override resolution entirely.
		const optedIn = environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: value, [GENTLE_AI_DEV_BINARY_OPT_IN_ENV]: "1" });
		assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, optedIn), isOverrideError(GENTLE_AI_DEV_BINARY_ENV), value);
	}

	const registrationPath = writeRegistration(home, "not-json\n");
	assert.throws(() => resolveGentleAiDevBinaryOverride(environment(home), PLATFORM), isOverrideError(registrationPath));
});

test("an unset or empty dev-binary environment preserves the package-local resolver", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	for (const env of [environment(home), environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: "" })]) {
		assert.equal(resolveGentleAiDevBinaryOverride(env, PLATFORM), undefined);
		assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), PackageLocalGentleAiBinaryMissingError);
	}
});

test("GENTLE_PI_CONFIG_HOME relocates only the local registration document", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const configHome = await scratch("gentle-pi-dev-config-");
	assert.equal(gentleAiDevBinaryRegistrationPath(environment(home, { GENTLE_PI_CONFIG_HOME: configHome })), join(configHome, "dev-binary.json"));
	assert.equal(gentleAiDevBinaryRegistrationPath(environment(home)), join(home, ".pi", "gentle-ai", "dev-binary.json"));
});

test("malformed registration variants name their local registration path and never fall back", async () => {
	const bin = await scratch("gentle-pi-dev-bin-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	const devBinary = writeDevBinary(bin);
	for (const contents of [
		"not json at all",
		`${JSON.stringify({ schema: "gentle-pi.dev-binary/v0", path: devBinary })}\n`,
		`${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA })}\n`,
		`${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA, path: "relative/gentle-ai" })}\n`,
		`${JSON.stringify([devBinary])}\n`,
	]) {
		const home = await scratch("gentle-pi-dev-home-");
		const registrationPath = writeRegistration(home, contents);
		const env = environment(home);
		assert.throws(() => resolveGentleAiDevBinaryOverride(env, PLATFORM), isOverrideError(registrationPath));
		// Fail-closed is asserted in the opted-in state; opt-out is a kill switch
		// that skips override resolution entirely.
		const optedIn = environment(home, { [GENTLE_AI_DEV_BINARY_OPT_IN_ENV]: "1" });
		assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, optedIn), isOverrideError(registrationPath));
	}
});

// Opt-in is a kill switch: it is evaluated before any override resolution, so a
// declaration the operator has opted out of can never block the pinned binary.
// A malformed declaration is still fail-loud the moment the operator opts in.
test("opt-out never resolves the override, and a malformed declaration only fails closed when opted in", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	const devBinary = writeDevBinary(bin);
	const registrationPath = writeRegistration(home, "not-json\n");

	// Opted out: the broken declaration is not consulted, so resolution reaches
	// the pinned path and fails there instead of raising the override error.
	const optedOut = environment(home);
	assert.equal(resolveGentleAiDevBinaryOptIn(optedOut).optIn, false);
	assert.throws(
		() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, optedOut),
		PackageLocalGentleAiBinaryMissingError,
	);

	// Opted in: the same declaration fails loudly and never falls back to the pin.
	const optedIn = environment(home, { [GENTLE_AI_DEV_BINARY_OPT_IN_ENV]: "1" });
	assert.equal(resolveGentleAiDevBinaryOptIn(optedIn).optIn, true);
	assert.throws(
		() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, optedIn),
		isOverrideError(registrationPath),
	);
});

test("a valid declaration is used only while opted in and never blocks the pin once opted out", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	const devBinary = writeDevBinary(bin);
	writeRegistration(home, registrationDocument(devBinary));

	assert.throws(
		() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, environment(home)),
		PackageLocalGentleAiBinaryMissingError,
	);
	assert.equal(
		resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, environment(home, { [GENTLE_AI_DEV_BINARY_OPT_IN_ENV]: "true" })),
		devBinary,
	);
});

test("a malformed opt-in declaration is surfaced before any override resolution", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	const optInPath = join(home, ".pi", "gentle-ai", "dev-binary-opt-in.json");
	mkdirSync(join(home, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(optInPath, "not-json\n");

	// No override is declared at all: the gate alone still fails loudly.
	const env = environment(home);
	assert.throws(() => resolveGentleAiDevBinaryOptIn(env), GentleAiDevBinaryOptInError);
	assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), GentleAiDevBinaryOptInError);
});

test("registered binary replacement is observed on the next resolution", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const devBinary = writeDevBinary(bin, "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+build1'\n");
	writeRegistration(home, registrationDocument(devBinary));
	const env = environment(home);
	const first = resolveGentleAiDevBinaryOverride(env, PLATFORM);
	writeFileSync(devBinary, "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+build2'\n");
	chmodSync(devBinary, 0o755);
	const second = resolveGentleAiDevBinaryOverride(env, PLATFORM);
	assert.notEqual(first?.sha256, second?.sha256);
	assert.equal(second?.path, devBinary);
});
