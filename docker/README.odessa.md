# OdessaExt watcher wiring

`ksnvqa-rfqa-intake.mjs` is the zero-token Kasanova lifecycle watcher.

Paperclip injects `PAPERCLIP_API_URL` as its public base URL. The watcher must
instead receive `KSNVQA_PAPERCLIP_API_URL=http://127.0.0.1:3101/api`; otherwise
routine calls lose the `/api` prefix and return HTTP 404.

The watcher state is stored under the external `paperclip_odessa_data` volume,
not in the source tree. The whole `docker/` directory is mounted read-only;
never return to a single-file watcher bind because atomic source updates leave
that bind pinned to a deleted inode.

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
separately prohibited.

On a brand-new watcher state, currently active non-`Done` lifecycle stages are
dispatched immediately. `Done` is baselined without replay. A migrated watcher
preserves its prior active set. The watcher caps any one Linear issue at three
entries into the same stage within 24 hours and leaves a durable Paperclip
comment for the responsible agent when the guard fires.
