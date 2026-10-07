# Spike: dev-binary opt-out is a real kill switch

## Objective

Resolve the open design decision about the ordering of opt-in evaluation and dev-binary
override resolution in `resolveGentleAiBinary`, and pin the chosen behavior with a test.

Today `lib/gentle-ai-binary.ts:403` resolves the override *before* reading the opt-in.
`resolveGentleAiDevBinaryOverride` throws `GentleAiDevBinaryOverrideError` on a malformed
declaration, so a broken `dev-binary.json` blocks startup even when the operator has
explicitly opted out. Opt-out is therefore not a kill switch.

## Constraints

- Strict behavioral TDD: focused RED before any production change, then GREEN.
- Stay inside the dev-binary override fence. No installer, pin, release-asset, or Windows
  source-build changes.
- Do not fix open issue #1717 (HOME leakage in
  `tests/gentle-ai-dev-binary-surfacing.test.ts`). Report conflicts instead of widening scope.
- No upstream writes, no push, no PR, no branch rename. The spike stays
  `task/spike-opt-in-dev-binary`.
- Ask before deleting any branch.

## Mechanism map

| Claim | Current anchor | Evidence |
| --- | --- | --- |
| Override resolution precedes opt-in evaluation. | `lib/gentle-ai-binary.ts:403-405` | `const override = resolveGentleAiDevBinaryOverride(...)` then `const optIn = resolveGentleAiDevBinaryOptIn(...)`. |
| A malformed declaration throws from inside that first call. | `lib/gentle-ai-binary.ts:167-176`, `140-177` | `readDevBinaryRegistration` and `validateDevBinary` throw typed errors; nothing between them consults opt-in. |
| Opt-out cannot therefore reach the pin. | `lib/gentle-ai-binary.ts:403-406` | The `override !== undefined && optIn.optIn` branch is only reached if resolution returned without throwing. |
| Surfacing of a broken declaration is an *independent* call path. | `extensions/gentle-ai.ts:9510-9516` | `describeDevBinaryOverride` calls `resolveGentleAiDevBinaryOverride()` directly inside its own try/catch and maps the error to the `invalid` state. It never goes through `resolveGentleAiBinary`. |
| The shell notice also resolves independently. | `extensions/gentle-shell.ts:99-106` | `ambientDevBinary` calls `resolveGentleAiDevBinaryOverride()` directly and maps the error to `{ state: "invalid" }`. |

## Decision

**Option (a) — kill switch. Opt-in is evaluated first; the override is resolved only when
opt-in is enabled.**

```ts
const optIn = resolveGentleAiDevBinaryOptIn(environment);
if (optIn.optIn) {
    const override = resolveGentleAiDevBinaryOverride(environment, platform);
    if (override !== undefined) return override.path;
}
```

### Rationale against (b) fail-closed

The "a declared override never falls back to the pin" discipline protects against *silently*
running an unpinned binary the operator did not intend. It does not require erroring when the
operator has explicitly declared the opposite intent. With opt-in disabled the operator has
asked for the pin; honoring that is the requested state, not a silent fallback. Option (b)
ratifies a gate that cannot open the exit it exists to provide: `gentle:dev-binary-mode
disable` would still leave the operator wedged by the very declaration they were escaping.

### Why the stated cost of (a) does not apply

The usual objection to a kill switch is that it hides a broken declaration until re-enable.
That does not hold here, because surfacing never routes through `resolveGentleAiBinary`.
`describeDevBinaryOverride` resolves the override itself and keeps reporting the `invalid`
state through `gentle:doctor`, `gentle:status`, and `gentle:dev-binary status` regardless of
the resolution order. The declaration is therefore still loud; it just stops blocking the
binary. This is what makes (a) strictly better than (b) here rather than a trade-off.

### Consequence worth pinning

A malformed *opt-in* declaration now surfaces `GentleAiDevBinaryOptInError` before any
override error. That is consistent: both declarations are fail-loud when present and invalid,
and the gate is the first thing consulted.

## Related inconsistency found, deliberately not fixed

`extensions/gentle-shell.ts:99` (`ambientDevBinary`) reports `state: "active"` without
consulting opt-in, so the shell notice can say "active" while `gentle:doctor` says
"optedOut". It is a surfacing inconsistency, not an execution bypass — it changes the notice
only. Fixing it is outside this decision's blast radius and is reported instead.

`extensions/quiet-tools.ts:616-618` also resolves the override without consulting opt-in, but
its result only builds a `RegExp` for render-time command recognition
(`registerQuietTool(pi, toolName, () => RegExp)`); it never executes the binary. Cosmetic
only.

`lib/runtime-metrics-policy.ts:15` keeps a strict `gentleAiDevBinaryOverrideConfigured()` guard
that fails the feature whenever any override is declared, opted in or not. That is
conservative and safe: it disables a feature, it does not select an unpinned binary.

## Result

**RED observed** before any production change, in `tests/gentle-ai-dev-binary.test.ts`:

```
not ok 7 - opt-out never resolves the override, and a malformed declaration only fails closed when opted in
  The error is expected to be an instance of "PackageLocalGentleAiBinaryMissingError".
  Received "GentleAiDevBinaryOverrideError"
  dev-binary-override-invalid: /tmp/.../dev-binary.json is not valid JSON.
```

**GREEN after** the change: that test plus the whole file pass 10/10.

Full unit stage: **3339 pass, 1 fail**. The single remaining failure is
`gentle:dev-binary registers, reports, and clears the persistent override`, which was
already red before this work and lives in the #1717 HOME-leakage file; it was not touched.

### One real regression found and fixed

`tests/runtime-metrics-native.test.ts` test 10 hung (300s timeout, never settled). Its
"invalid dev override fails closed" premise depended on the override being resolved at all.
Under the kill switch an opted-out invalid declaration legitimately resolves to the pinned
binary, so the transport spawned it against the fake child, which never emits `close`, and
`sendProcess` only cancels on a `unref`'d timer without settling. Opting the test in restored
its intent; the file is 20/20.

### Pre-existing red tests repaired here

Commit 92c39957 introduced the opt-in gate but did not update the tests that assert the
pre-opt-in contract. Verified pre-existing by stashing only the changed tracked files and
re-running the single file (identical failure before and after):

| File | Test | Status |
| --- | --- | --- |
| `tests/gentle-ai-dev-binary.test.ts` | explicit env override resolves | repaired here |
| `tests/gentle-ai-binary.test.ts` | absolute package-local binary path | repaired here |
| `tests/runtime-metrics-native.test.ts` | validated dev override reaches child | repaired here |
| `tests/gentle-ai-dev-binary-surfacing.test.ts` | `gentle:dev-binary registers...` | **left red on purpose** (#1717 file) |

## Housekeeping finding: the `test-spike` worktree is not disposable

`test-spike` points at the same commit as the spike branch (`92c39957`), which makes the
*branch* look redundant, but the worktree checked out on it was **not clean**. It held three
uncommitted files from the spike author, including the fix for the one test left red above.
Running that worktree's own two files gives 13/13 green, which the primary checkout does not
have.

Owner decision: keep the worktree, commit its work first, keep the branch, switch the primary
checkout to `main`, leave `package-lock.json` untouched. The salvaged work is now
`d7c54d2e` on `test-spike`.

### The two branches encode different designs

Neither branch alone is fully green, and this is the coordination hazard to resolve next:

- `test-spike` (`d7c54d2e`) is green, but it keeps the **pre-Task-1 ordering**: its
  `invalid override sources fail closed` and `malformed registration variants` cases assert
  that an invalid declaration throws *without* any opt-in, i.e. option (b).
- `task/spike-opt-in-dev-binary` (`6428b6cb`) carries the kill switch, and those same two
  cases were updated to opt in first, because under the kill switch an opted-out invalid
  declaration no longer throws. Its one remaining red is the surfacing test that `test-spike`
  fixes.

Both branches also edited the same line of `tests/gentle-ai-dev-binary.test.ts` (mine adds an
`optedIn` environment, the author's folds opt-in into `env`), so any cherry-pick between them
will conflict there. The intended end state is `6428b6cb` plus the `test-spike` test
repairs, keeping the opted-in assertions.

