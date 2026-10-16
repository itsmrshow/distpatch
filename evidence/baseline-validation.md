# M0 baseline validation evidence

## Audited implementation baseline

`developerz-ai/multi-ai-router@6d30948d560b4df2dab56be31879c143ddb24223` (`v2.39.2`).

The M0 audit inspected the exact pinned source and its GitHub CI/release state. Upstream CI for the exact SHA was green across installation, lint/typecheck, tests, build and the repository's benchmark/UI gates; release image workflows also completed for the corresponding release.

## Local execution limitation during audit

The original audit sandbox lacked Bun and Docker and could not resolve GitHub from the container. Therefore local `bin/check`/container execution was not used as evidence. This was classified as environment-limited, not a product failure.

## Fork creation timing

The genuine Distpatch fork was subsequently created on `v2.39.3` at `903b486683b6d4072debd5e8bd607bc12d87242f`. Git history verifies that commit directly parents from the audited `6d30948...` baseline. M0 findings remain pinned to `v2.39.2`; publication does not rewrite fork `main`.

## Runtime-change verification

The M0 branch is created from `903b486...` and the M0 publication commit is restricted to Markdown/JSON documentation and project metadata. No application, package, migration, test, workflow, container, or runtime configuration file is modified.