# M1C Antigravity multi-account isolation gate

## Verdict

**BLOCKED.** No adapter code was written. On the version tested live, the official `agy` CLI exposes
**no supported isolation selector** for its model-serving identity, holds **exactly one credential
slot**, and only **one** operator-authorized Antigravity identity exists on the test host. Per the
M1C gate definition, two sequential logins into one shared slot are not multi-account isolation, and
one account plus speculation is not proof.

Container and OS-user isolation are **not disproven**. They remain unproven alternatives that would
each require explicit security review, a second real account, and a design preserving CLI-owned
credentials without token copying.

| Field | Value |
|---|---|
| Date | 2026-10-16 |
| Host | `rob-mini01` |
| OS | Ubuntu 26.04.1 LTS (Resolute Raccoon), kernel 7.0.0-38-generic, x86_64 |
| Host account | a single non-system Unix user (uid 1000) — the only one on the host |
| Installed `agy` at session start | **1.2.14** at `~/.local/bin/agy` |
| Version used for live model calls | **1.4.0** — see "Version history and what was actually executed" below |
| `agy` install source | pre-existing official flat-native binary; official bootstrapper verified at `https://antigravity.google/cli` (Google-hosted updater with SHA-512 staged verification) |
| Distpatch baseline SHA | `3e69744443baebb0b25a76557d9e911eb55968c9` (origin/main, M1A merge, PR #16) |
| Branch | `m1c/antigravity-isolation` |
| Baseline checks | `bin/lint` → exit 0 · `bin/test` → **6477 pass / 0 fail** (DB integration suites skipped: `DATABASE_URL` unset) |

## Version history and what was actually executed

This matters for reading the rest of the document accurately.

- The CLI **self-updated in the background during the session**, from **1.2.14 → 1.4.0**, at
  `22:19:47`. The in-session update record is `{"success":true,"message":"Update successful, restart CLI to use"}`,
  and the log line at `22:19:45` reads `Language server version: 1.2.14` followed by
  `Spawned background update process`.
- Consequently the two versions were observed as follows:

| Observation | Version actually executed |
|---|---|
| `agy --version` at session start | 1.2.14 |
| All later `agy --version`, `--help`, subcommand-list and flag-list reads | **1.4.0** |
| `agy models` listings | **1.4.0** |
| Live headless model calls and the stream-json capability probe | **1.4.0** |
| Isolated-HOME 1.4.0 re-verification (below) | **1.4.0** |

- The bundled changelog is the same artifact in both builds and documents releases up to **1.4.0**.
  No profile or multi-account feature appears anywhere in its 1.0.0 → 1.4.0 entries.

## Documentation and help inspected

- `agy --version` → `1.2.14` at session start, `1.4.0` after the background update
- `agy --help` (full top-level flag list + complete subcommand list)
- `agy models --help`, `agy install --help`, `agy plugin --help`, `agy agents`
- `agy changelog` (bundled release notes, versions **1.4.0 → 1.3.6 → … → 1.0.0**)
- Official bootstrapper source at `https://antigravity.google/cli`
- Static string surface of the installed binary (`strings`), used only to enumerate env-var and
  config-root candidates. **No keyring secret values were read and no tokens were dumped.**

## Isolated re-verification of 1.4.0

Run in a throwaway `HOME` so the operator's authenticated session was neither read nor disturbed.
No authentication was attempted, no logout was performed, and no existing credential file was
modified (the operator's token file remained in place at mode `0600`, and a live model call after
the re-verification still succeeded).

```
$ T=$(mktemp -d)
$ env -i PATH=/usr/bin:/bin:$HOME/.local/bin HOME=$T agy --version
1.4.0

$ env -i PATH=... HOME=$T agy --help          # complete subcommand list
agent, agents, changelog, help, install, mcp, mic-serve,
models, plugin, plugins, remote-control, update

$ env -i PATH=... HOME=$T agy --help | grep -iE 'profile|account|user|home|config|identity|credential|switch|login|logout'
install         Configure environment paths and shell settings     # only a false positive on "paths"

$ env -i PATH=... HOME=$T agy models
Fetching available models...
Error: Please sign in to view available models. Launch the CLI without arguments to sign in.
   # confirms isolated HOME is genuinely signed out — no fallback to the operator identity

$ env -i PATH=... HOME=$T agy login
Error: unexpected argument "login".
```

`ANTIGRAVITY_CONFIG_REL_DIR` re-tested on 1.4.0 in an isolated `HOME`: the CLI created the ordinary
`~/.gemini/antigravity-cli/` tree and **no** directory matching the supplied value.

So on the version actually being executed, the surface that matters for this gate is confirmed
directly rather than inferred. The gate is therefore **not** blocked by "the newest release might
differ" — it is blocked by what 1.4.0 itself does.

## Isolation mechanisms investigated

### A. Official named profile / credential-root mechanism — **none found in the tested version**

On 1.4.0 the complete subcommand list is `agent, agents, changelog, help, install, mcp, mic-serve,
models, plugin, plugins, remote-control, update`. There is no `login`, `logout`, `accounts`, `auth`,
`signin`, `whoami`, `status`, `identity`, or `use` subcommand; each was probed and rejected. No
top-level flag matches `profile`, `account`, `user`, `home`, `config`, `identity`, `credential`, or
`switch`.

Environment-variable candidates were enumerated exhaustively from the binary (21 `AGY_*`, plus
`GEMINI_*` and `ANTIGRAVITY_*`), and re-verified on 1.4.0:

| Candidate | Verdict |
|---|---|
| `AGY_ACCOUNT` | **Not a credential selector.** Its own in-binary documentation defines it for *plugin* accounts only: *"To run a sandboxed CLI command with a specific account, prefix it with `AGY_ACCOUNT=<account>` (e.g. `AGY_ACCOUNT=account-2 gh api user`). Without the prefix, the default account is used."* It selects among accounts connected in the **Plugins Manager** for third-party plugin CLIs — not the Antigravity model-serving identity. Confirmed on 1.4.0. |
| `AGY_ADC_AUTH` | Application Default Credentials sign-in path. Under an isolated `HOME` it did not resolve an identity. |
| `ANTIGRAVITY_CONFIG_REL_DIR` | Present as a string but **not honored as a config-root override** — disproved twice, on 1.2.14-era behavior and again directly on 1.4.0 in an isolated `HOME`. |
| `XDG_CONFIG_HOME` | Not honored; still resolved `~/.gemini/antigravity-cli/`. |
| `AGY_CONFIG_DIR` / `AGY_HOME` / `GOOGLE_CONFIG_HOME` | Do not exist in the binary. Not invented, not guessed. |
| `GEMINI_API_KEY` | An API-key auth path, not a second Antigravity identity, and outside the intended CLI-owned-subscription boundary. |

`ANTIGRAVITY_CONFIG_REL_DIR` disproof on 1.4.0:

```
$ T=$(mktemp -d)
$ env -i PATH=... HOME=$T ANTIGRAVITY_CONFIG_REL_DIR="ZZZALT" agy models >/dev/null
$ find $T -maxdepth 3 -type d
./.gemini
./.gemini/antigravity-cli
./.gemini/antigravity-cli/brain
./.gemini/antigravity-cli/builtin
./.gemini/antigravity-cli/cache
./.gemini/antigravity-cli/conversations
./.gemini/antigravity-cli/crashes
./.gemini/antigravity-cli/log
./.gemini/antigravity-cli/updater
./.gemini/config
./.gemini/config/projects

$ find $T -name '*ZZZALT*'
(empty)
```

### B. OS-user / native-keyring isolation — **unproven**

The credential root is `$HOME`-derived, so per-OS-user separation is a plausible isolation
boundary. On 1.4.0 a throwaway `HOME` yields a genuinely signed-out CLI with no fallback to the
operator identity.

It remains **unproven**, for two reasons:

1. **Only one operator-authorized account exists.** Establishing account B requires a human to
   complete an interactive Google OAuth browser consent. It cannot be automated, and no second
   identity was available to test with.
2. **No desktop keyring on this host.** `gnome-keyring`, `kwalletd5/6` and `secret-tool` are all
   absent, and `busctl --user status org.freedesktop.secrets` returns
   `Failed to get credentials: No such device or address`. There is no secret-service collection to
   isolate here, so the "separate native keyring per identity" property has not been demonstrated
   on any host.

A further consideration for any future design: invoking a second user's CLI requires the router to
cross a Unix user boundary. This host grants `(ALL) NOPASSWD: ALL` to its non-system user, so a
Distpatch process holding that identity could run `agy` as any user. `sudoers`/security policy was
**not** modified here, and such a design would require explicit human security review before it is
designed.

### C. Container / keyring isolation — **unproven**

Container isolation was **not tested**. It is neither disproven nor impossible. A container-based
design *could* preserve CLI-owned credentials — each container running the unmodified official
`agy` with its own credential domain and its own mounted state — provided it never bakes tokens into
an image or an environment variable, and never mounts one identity's keyring into another's
container.

It was not attempted because both prerequisites are missing today: a second real account to place
in a second container, and a decision — with explicit security review — about whether Distpatch may
own container lifecycle at all. Neither is a statement about feasibility; both are open questions.

## Credential model as actually observed

Model-serving credentials resolve to a **single file, single token object, single slot**:

```
~/.gemini/antigravity-cli/antigravity-oauth-token          mode 0600
  top-level keys: token, auth_method, id_token
  token objects in file: 1
  auth_method: consumer
  token keys: access_token, token_type, refresh_token, expiry
```

Operator identity A was confirmed through **non-secret ID-token claims only** (email/verified/name
and issuer fields). Those values are deliberately **redacted from this document** — see
"Redaction note". No token material was read, printed, or copied.

There is no account registry, no account index, and no account-id file in the config root. The
bundled changelog describes sign-in as a **replacement**, not an addition:

- *"stale business project and license details are fully cleared on personal sign-in"*
- *"the CLI signs you out and clears the stale tokens so you can sign in again"*
- *"incomplete enterprise sign-ins … those credentials are now cleared automatically"*

Two sequential logins therefore overwrite the same slot. That is explicitly **not** isolation.

### Redaction note

This is a public repository. The evidence deliberately records **no** real email address, personal
name, or OAuth client identifier. Identity is stated only as:

> operator identity A confirmed via non-secret ID-token claims

The original claim values were read once to establish that exactly one identity was signed in, then
removed. No access token, refresh token, or ID token string appears anywhere in this repository, in
its commit history, or in any log produced by this investigation.

## Two-account test procedure — **not executable**

The gate requires two distinct operator-authorized identities A and B. Only A exists.

| Required live step | Status |
|---|---|
| Verify identity for A via non-secret CLI metadata | **done** — non-secret ID-token claims only |
| `agy models` under A | **done** — 13 IDs, e.g. `gemini-3.8-flash-low`, `claude-opus-5-5-high`, `gpt-oss-120b-medium` |
| Tiny headless text request under A | **done** — `agy --model gemini-3.8-flash-low --print="Reply with exactly: AGYPROBE-OK"` → `AGYPROBE-OK` |
| Conversation ID emitted | **done** — `--output-format stream-json` emits `{"event":"init","conversation_id":"…","init":{…}}` |
| Stream-json capability probe | **done** — emits `init` / result events with model, cwd, tool list |
| Establish identity B | **BLOCKED** — no second authorized account exists |
| Concurrent A ‖ B | **NOT RUN** — requires B |
| Resume A's conversation under B | **NOT RUN** — requires B |
| Resume B's conversation under A | **NOT RUN** — requires B |
| Cross-account conversation result | **UNDETERMINED** |

No logout/destroy test was performed against the operator session. Doing so would have disturbed a
live account to manufacture a result the gate already refuses to accept. The session was verified
intact after all probing.

## Concurrent invocation result

Not run for A/B (no B). Single-identity concurrency was observed incidentally during probing and
behaved normally, but it says nothing about account-state crossover and is not offered as gate
evidence.

## Cross-account conversation result

**Undetermined.** With a single-slot credential and a single identity, any resume test would run
under the same identity on both sides and could not distinguish isolation from leakage.

## Credential ownership

- **Good:** Antigravity credentials are owned entirely by the `agy` CLI. Nothing was copied into
  Distpatch, and no Distpatch code, schema, migration, or driver was written or modified in this run.
- **Good:** login and refresh stay CLI-side. The CLI refreshes its own token; Distpatch reads nothing.
- **Good:** the operator's authenticated session was never logged out and its credential file was
  never modified. The isolated-HOME re-verification read no operator credential.
- **Concern:** on this host the credential is a **plaintext-at-rest OAuth token file** under `$HOME`
  (mode `0600`, containing access + refresh tokens), because there is no secret service available.
  Go's keyring backend is compiled in (`zalando/go_keyring`, `auth.keyringAuth`,
  `keyring_detector_*`), but the runtime fallback is that file. Any deployment model must treat it
  as a secret at rest.

## Filesystem and keyring boundaries

- Credential root: `~/.gemini/antigravity-cli/` — `$HOME`-derived, no override honored.
- Token file: `~/.gemini/antigravity-cli/antigravity-oauth-token`, mode `0600`.
- Conversation state: `~/.gemini/antigravity-cli/conversations/`, plus
  `conversation_summaries.db`, `brain/`, `presence/` — all under the same single-slot root, so
  conversation state is account-scoped **only** because there is only one account.
- Keyring: compiled in, unavailable at runtime on this host (no secret service).

## Router invocation implications

The only reproducible selector observed is the **OS user / `$HOME`**, which means selecting an
identity would mean the router crossing a user boundary — making the router's privilege model the
real security boundary, a materially different and more dangerous posture than the Claude
`CLAUDE_CONFIG_DIR` model, and one that has not been reviewed. Additionally:

- `agy` is an **agentic** CLI. In headless print mode a tool needing `command` permission is
  auto-denied with a non-zero-class failure (`jetski: no output produced — a tool required the
  "command" permission that headless mode cannot prompt for`). A production adapter must run it in a
  disposable working directory under an allowlisted environment; the repo must never be the cwd.
- `--print` requires the prompt **attached to the flag** (`--print="…"`); a detached prompt is
  silently ignored with an explicit error. argv construction must respect this.

## Additional findings (recorded, not acted on)

- `agy models` has **no JSON flag** — output is a tab-separated `id<TAB>label` list. Confirmed on
  1.4.0. A structured parser must be built on the installed version's actual format, and the catalog
  must never be hard-coded.
- Changelog 1.3.3: headless runs that stream partial output then error **exit 3** and print an
  `AGY_ERROR` line; JSON error output includes the partial response. Relevant to failure
  classification, and to the "no replay after observable output" rule.
- Changelog 1.3.6/1.4.0 add `AGY_ADC_AUTH` and Claude models gated on Google Cloud project access.
- `/usage` quota was **not** probed. Per M1C quota policy, unknown headroom stays `unknown`; it is
  never translated into unlimited.

## Limitations of this evidence

- One host, one OS user, one account. Isolation mechanisms B and C are **unproven**, not disproven.
- 1.4.0 was executed and its surface verified directly; 1.2.14 was executed only briefly at session
  start. A build newer than 1.4.0 could differ and has not been tested.
- Findings come from the installed binary's own help, changelog, observable filesystem behavior, and
  static string surface — not from published Antigravity account-management documentation, which was
  not reachable from this host. Absence of a profile mechanism in the tested version's help and
  changelog is strong but is not the same as a published vendor statement.
- The `AGY_ACCOUNT` plugin-account distinction was read from the binary's own tool descriptions and
  corroborated by behavior (unknown `AGY_ACCOUNT` values do not error and do not change model
  availability), but was not confirmed against vendor documentation.
- The CLI self-updated mid-session. Anyone reproducing this should pin a version explicitly, because
  a background update can silently change which build answers.

## Why this is BLOCKED

The gate is BLOCKED on these conditions, any one of which is sufficient:

1. **Only one real account available** — account B does not exist and cannot be created without a
   human Google OAuth consent.
2. **One shared single-slot credential** — the credential file holds exactly one token object;
   sign-in replaces rather than adds. No per-account keyring slot exists to isolate.
3. **No supported isolation selector found in the tested version** — no flag, no subcommand, no
   honored environment variable.
4. **Cross-account conversation behavior undetermined** — structurally unprovable without B.

Options B (OS-user) and C (container) are **not** among these reasons: neither was tested and
neither is ruled out. They are gated on a second real account and on explicit security review.

**Implementation is prohibited.** No `antigravity` ProviderId, no subprocess driver, no schema
change, no OAuth work, no model-routing code was added. The credential boundary was not weakened
to manufacture progress.