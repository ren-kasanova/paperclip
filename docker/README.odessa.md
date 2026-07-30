# OdessaExt watcher wiring

`ksnvqa-rfqa-intake.mjs` is the zero-token Kasanova lifecycle watcher.

Paperclip injects `PAPERCLIP_API_URL` as its public base URL. The watcher must
instead receive `KSNVQA_PAPERCLIP_API_URL=http://127.0.0.1:3101/api`; otherwise
routine calls lose the `/api` prefix and return HTTP 404.

The watcher state is stored under the external `paperclip_odessa_data` volume,
not in the source tree. The whole `docker/` directory is mounted read-only;
never return to a single-file watcher bind because atomic source updates leave
that bind pinned to a deleted inode.

The lifecycle watcher serializes its Linear reads and holds an atomic,
heartbeat-refreshed, ownership-token lock so timer and event wakes cannot
process the same cycle concurrently. Every upstream request has a bounded
timeout. State schema v5 keeps durable stage-entry sequences for stable
dispatch idempotency and a rejection ledger keyed by the immutable Linear
`QA REJECTED` comment ID. A successful routine dispatch is checkpointed before
the watcher performs later enforcement, so a crash cannot duplicate the stage
task.

While the source issue is `In Progress`, the watcher reads the complete
paginated Linear comment history, audits the structured rejection, creates or
reopens the single source-bound Delivery monitor idempotently, and records the
cycle ID in both the monitor policy and a read-before-write Paperclip comment.
Incomplete historical formatting is a durable evidence warning but does not
strand the immutable handoff. A `QA RETURN RESOLVED` closes that cycle only
when it cites the exact rejection ID. The watcher continues observing the
source issue after it leaves `In Progress`; advancement without the cited
return is an invariant violation, not implicit success. Legacy
`resolved_or_advanced` ledger entries are re-verified under this rule. `done`
monitors can be reopened; `cancelled` monitors fail closed and are reported as
source-bound invariant work.

Each rejection cycle receives one durable 72-hour return deadline derived from
its first detection time. Repairs preserve that deadline and the monitor's
complete execution policy, including review and authorization settings. An
unresolved cycle that reaches the deadline or exhausts its bounded attempts
stops re-arming and creates source-bound invariant work. The regular one-hour
return cadence cannot exhaust 96 attempts before the 72-hour deadline. Legacy
monitors missing from the ledger use their persisted monitor deadline and
surface equivalent invariant work.

When Linear records the exact cited `QA RETURN RESOLVED`, the watcher closes
the corresponding Delivery monitor, clears its execution policy, and removes
the Delivery assignee so comments cannot wake obsolete work. Malformed
rejection evidence always has a durable destination: an open source task gets
one marker-guarded warning, otherwise the watcher creates one source-bound QA
evidence-repair task.

An existing future monitor deadline, active execution, recent wake/trigger, or
pending interaction is a live delivery path. The minute watcher does not
rewrite a live deadline, which prevents a frequent poll from postponing the
monitor forever. A stale deadline with no other live path is repaired.

Each event routine declares required `linear_identifier` and `linear_title`
variables. The watcher supplies the exact Linear key and source title so its
Paperclip execution title is born as
`[KSNV-###] <subject> — <QA action>`. The scheduled cross-ticket fallback is
the only exception and is labeled `[LINEAR-SWEEP]`.

Board confirmations are not handled inside the container. The trusted
host-side `com.odessa.paperclip-deck7-router` LaunchAgent polls Paperclip's
attention feed and uses the authenticated DECK·7 `paperclip` source. This keeps
the DECK·7 source credential off the container and preserves Paperclip as the
authoritative decision record.

Malformed confirmation requests are rejected by policy before they reach Ren:
reads, browser authorization, and assigned Android use cannot be approval
subjects. Production-promotion confirmations additionally require an immutable
custom target containing the KSNV key, exact release path, artifact/release
revision, digest, and rollback evidence. Valid state-changing confirmations
remain pending for Ren and are routed by DECK·7.

The server reads only a copy of the relay credential from the external
`paperclip_odessa_deck7_router` volume. Colima does not reliably project the
router's macOS home directory into containers, so do not restore that host
directory bind.

Kasanova Flutter execution uses the external ARM64 cache volumes documented
in `ODESSA.md`. Provision them with
`host/provision-kasanova-dart-sdk.sh`; never install toolchains or
`node_modules` at the OdessaExt root.

KSNVQA Codex runs use Paperclip's Landlock wrapper as the mandatory filesystem
sandbox. The Bubblewrap default cannot create its user namespace in Colima,
and Codex's legacy Landlock backend cannot enforce the managed direct-permission
profile. Ren explicitly authorized Kasanova QA on 2026-07-30 to use Codex's
combined sandbox/approval bypass and rely on the outer Landlock boundary. This
removes nested noninteractive prompts only; real governed effects still route
through Paperclip interactions and DECK·7, and browser access remains
separately prohibited. Kasanova QA runs have a one-hour total timeout and
Paperclip's seven-minute output-inactivity guard. Linear MCP calls are
serialized so one bounded upstream request owns the active timeout path.

On a brand-new watcher state, currently active non-`Done` lifecycle stages are
dispatched immediately. `Done` is baselined without replay. A migrated watcher
preserves its prior active set. The watcher caps any one Linear issue at three
entries into the same stage within 24 hours and leaves a durable Paperclip
comment for the responsible agent when the guard fires.

The container healthcheck requires the watcher health record to remain `ok`
and less than five minutes old. Any stage dispatch failure, lifecycle-guard
delivery failure, or monitor/rejection invariant violation changes watcher
health to `degraded`; stderr alone is never treated as a successful poll.
Compose allows a 90-second healthcheck start period for the first heartbeat.

Paperclip issue and comment reads are fully paginated. Routine-execution rows
are excluded from the minute watcher scan so historical fallback runs cannot
push an idle Delivery monitor out of view. `host/reconcile-ksnvqa.mjs --check`
audits all pages of the project, the five-minute intake runtime, routine titles
and variables, the `0 */8 * * *` `America/Monterrey` fallback trigger, and
source-bound Paperclip titles.

Watcher `degraded` means the poll completed but lifecycle work needs attention;
the healthcheck accepts it as a live control plane. Only `error`, an invalid
record, or a stale poll marks the Paperclip container unhealthy.
