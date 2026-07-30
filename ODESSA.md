# Paperclip on OdessaExt

Paperclip is the first-level local control plane for OdessaExt.

## Canonical layout

- Runtime source and Compose file: `/Volumes/OdessaExt/Paperclip`
- Company configuration: `/Volumes/OdessaExt/Paperclip/companies`
- Kasanova QA company: `/Volumes/OdessaExt/Paperclip/companies/KSNVQA`
- Local endpoint: `http://localhost:3100`

The Compose deployment is canonical. It runs through Colima and persists
control-plane state and agent homes in the external named volumes declared in
`compose.yaml`. Recreating the container must not replace those volumes.
The same rule applies to the authenticated DECK·7 relay token and Kasanova's
Linux ARM64 Flutter/Dart cache; neither depends on a Colima-visible macOS home
bind.

The Compose process wrapper supervises both the Paperclip server and the
port-3100 loopback proxy. If either exits, the wrapper exits so Docker's
`unless-stopped` policy recreates the whole service instead of leaving an
unhealthy but permanently running container.

## Operational boundaries

- Company instructions and policies belong under their company directory.
- Every Paperclip work item mirrored from Linear must begin its title with the
  exact source key in brackets, for example `[KSNV-162]`. Do not fabricate a
  key when no Linear issue exists; cross-ticket monitors use
  `[LINEAR-SWEEP]`.
- Runtime watcher implementation belongs beside the watcher under `docker/`.
- Product repositories remain in their own first-level OdessaExt workspaces.
- Active Paperclip configuration must not depend on files under
  `/Volumes/OdessaExt/Agentic`.
- The persistent host Android reservation remains
  `/Volumes/OdessaExt/USING_ANDROID_DEVICE.lock`. Paperclip mounts the OdessaExt
  directory read-only at `/odessa-root`, so the in-container path is
  `/odessa-root/USING_ANDROID_DEVICE.lock`. Directory mounting keeps atomic
  host writes visible; never restore the fragile single-file bind. Release the
  reservation by changing its state to available/unowned; do not delete it.
- The host ADB server listens only on macOS loopback port `5038`. Colima exposes
  that private loopback service to the container as
  `host.docker.internal:5038`; KSNVQA agents receive that value through
  `ADB_SERVER_SOCKET`.
- `PAPERCLIP_API_URL` is reserved by the runtime. The KSNVQA lifecycle watcher
  uses `KSNVQA_PAPERCLIP_API_URL` for its internal `/api` target.
- KSNVQA local Codex processes run non-interactively inside Paperclip's
  mandatory Landlock boundary. Codex's Bubblewrap default requires a user
  namespace unavailable inside the Colima container, while Codex's legacy
  Landlock backend is incompatible with its managed direct-permission profile.
  Ren explicitly authorized Kasanova QA on 2026-07-30 to use Codex's combined
  sandbox/approval bypass and rely on the mandatory Paperclip Landlock
  boundary. This removes nested noninteractive prompts; it does not expand the
  mounted filesystem policy, grant browser access, or bypass Paperclip and
  DECK·7 governance for state-changing or production effects.

## Board decision routing

The owner-level LaunchAgent `com.odessa.paperclip-deck7-router` is the durable
Paperclip board-attention bridge. Its source lives under `host/`; the installed
runtime and state live at `~/.paperclip-deck7-router` because launchd cannot
reliably execute from the external OdessaExt volume.

- The router polls Paperclip's real company attention feeds every 15 seconds.
- The LaunchAgent pins Node 22 LTS and uses launchd's `Interactive` process
  class so a human-confirmation poll is not delayed in background startup.
- TCP `8765` is reserved exclusively for `deck7d`; QA fixtures must bind a
  different port.
- `request_confirmation` interactions and first-class approvals become urgent
  DECK·7 takeover questions under the authenticated `paperclip` source.
- An explicit `Approve` answer is revalidated against the exact still-pending
  Paperclip record before the matching accept/approve endpoint is called.
- `Hold` does not mutate Paperclip. Ren can provide changes in the Paperclip
  thread.
- Unresolved decisions remain durable and continue retrying at the bounded
  router cadence; delivery failures never become a silent terminal state.
- Structured questions and other non-binary interactions become high-priority
  notices only; the router never fabricates answers.
- Telegram and Jack are not approval authorities. They may be added later as
  notification-only fallbacks.
- DECK·7 relays attach an authenticated decision-provenance record containing
  the exact prompt id, choice id, and response time. A relay without the
  host-only router token is rejected.

`local_trusted` is intentional for this private single-operator deployment:
the published socket is restricted to macOS loopback. Authenticated DECK·7
provenance is an additional trust boundary for relayed decisions, while direct
board actions remain available to the local operator.

The router is dependency-free and does not consume model tokens. Install or
refresh it with `host/install-paperclip-deck7-router.sh`. The installer keeps
the host router credential and the external
`paperclip_odessa_deck7_router` Docker volume synchronized without printing
the credential.

## Kasanova toolchain

Paperclip runs as Linux ARM64 under Colima, while a host-seeded Flutter cache
can contain macOS or Linux x64 executables. Compose overlays the Kasanova
Flutter cache with the external
`paperclip_odessa_kasanova_flutter_cache` volume and overlays its Dart SDK
with `paperclip_odessa_kasanova_dart_sdk`.

Run `host/provision-kasanova-dart-sdk.sh` before the first deployment or after
changing the pinned Flutter engine. It derives the exact engine revision from
Kasanova's existing Flutter checkout, verifies the downloaded Dart ELF is
ARM64, and seeds persistent cache metadata. It does not replace the host
checkout or place dependencies at the OdessaExt root.

The canonical Compose deployment replaces the retired
`com.paperclip.control-plane` LaunchAgent. That legacy LaunchAgent must remain
booted out and absent from `~/Library/LaunchAgents`.
