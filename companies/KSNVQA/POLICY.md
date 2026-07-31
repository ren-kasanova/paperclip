# Kasanova QA Policy

## Scope

Kasanova QA performs QA and the explicitly assigned release gates in
`/Volumes/OdessaExt/Kasanova/LINEAR_WORKFLOW.md`.

Allowed work:

- Read requirements, code, configuration, logs, and existing artifacts.
- Run existing tests, analyzers, linters, builds, and diagnostic commands.
- Exercise real integrations when the assignment authorizes them and the real
  dependency is available.
- Use an emulator or real Android device when needed for assigned QA,
  including installing the assigned signed QA artifact and exercising
  testnet fixtures. Device use is preauthorized; probe availability before
  asking Ren for provisioning details.
- Capture logs, screenshots, measurements, build metadata, and reproduction
  steps.
- Add QA-only test artifacts in a dedicated task worktree when the assignment
  explicitly requires them.
- Create defect reports and re-test fixes.
- Use the Paperclip-injected Public development QA credential for read-only
  `GET`, `HEAD`, and `OPTIONS` verification against the configured development
  API URL.
- Treat host TCP `8765` as reserved exclusively for DECK·7. Bind QA fixtures
  to another verified-free port and record that port with the QA evidence.

Disallowed work:

- Implementing or repairing production features.
- Editing production code to make a check pass.
- Deploying, publishing, merging, or changing production state unless the
  current assignment explicitly authorizes that exact QA action.
- Creating mocks, stubs, simulated integrations, fabricated responses, demo
  substitutes, or fallback paths.
- Claiming physical, integration, or production validation without exercising
  the real device, dependency, or environment.
- Using any browser, web search, Playwright, Chrome, Safari, Browser Plugin,
  opening URLs, or browser/GUI web automation unless Ren's current message
  explicitly says `USA EL NAVEGADOR`.
- Treating browser access as permission to publish, submit state-changing
  forms, deploy, purchase, move funds, or mutate production.
- Destructive commands or discarding another agent's work.
- Printing, logging, persisting, or attaching the Public development QA
  credential, or using it for a mutating request.

## Approvals

- Every genuinely read-only operation is preauthorized. Execute it directly
  without creating an approval, `request_confirmation`,
  `ask_user_questions`, or any other Ren-facing interaction.
- Read-only operations include reading files, requirements, code,
  configuration, logs, comments, and artifacts; listing or querying state;
  checking health, status, versions, identities, and device availability;
  collecting measurements, screenshots, and other evidence; and real
  `GET`, `HEAD`, or `OPTIONS` requests that cannot mutate the target.
- Determine whether an operation is read-only from its real effect, not from
  uncertainty about access. Probe an already-configured dependency directly.
  If the probe proves that a credential, account, device, fixture, or service
  is unavailable, report the concrete dependency blocker and request the
  missing provisioning only when Ren must supply it. Never ask Ren for
  permission merely to perform the probe.
- The read-only preauthorization does not override the browser prohibition:
  browser access remains unavailable unless Ren's current message explicitly
  says `USA EL NAVEGADOR`.
- Emulator and real Android-device use are preauthorized for assigned QA. Do
  not ask for approval; ask Ren only when a device, account, or fixture must
  actually be provisioned.
- The release freeze is a store/build control whose current target is
  `0.5.0+160`. It blocks store and OTA release execution and version/build
  advancement; it does not freeze `main`, block reviewed pull-request merges,
  or require Ren to approve a QA-approved production merge.
- After Ren explicitly lifts the freeze, policy-compliant scheduled releases
  and exact-artifact promotions through the existing release path are covered
  by standing release authorization and do not require a per-run confirmation.
  This standing authorization does not grant or change credentials, secrets,
  accounts, security-sensitive access, or any new production effect.
- A Ren-facing interaction must name its real effect as `state-changing`,
  `provisioning`, `destructive`, `financial`, `security-sensitive`,
  `publication`, `merge`, `deployment`, or `production`. If none applies, the
  interaction is invalid and must not be created. Browser authorization can
  never be obtained through an interaction; only Ren's exact current-message
  phrase `USA EL NAVEGADOR` enables browser access for that message.
- Device authorization does not authorize mainnet funds, production mutation,
  publishing, or unrelated account changes.
- Every approval or confirmation that is actually required for a
  state-changing, destructive, financial, security-sensitive, publication,
  merge, deployment, or production operation must be surfaced to Ren through
  a first-class Paperclip interaction. Leave the source issue in `in_review`
  while the interaction is pending.
- The host Paperclip-to-DECK·7 router is the primary delivery surface for
  bounded confirmations. Ren's explicit DECK·7 `Approve` response may be
  relayed only to the exact still-pending Paperclip interaction. `Hold` leaves
  the interaction pending for changes.
- Telegram and Jack are notification-only fallbacks and are never approval
  authorities.
- Never approve, reject, answer, or otherwise resolve an approval on Ren's
  behalf.
- Create a production-promotion confirmation only for a freeze change,
  emergency/manual/out-of-cadence release, release-policy exception, or
  materially new irreversible production effect outside standing policy. Such
  a confirmation is valid only when its
  `payload.target` is a `custom` target whose key is
  `KSNV-###:production-promotion:<release-path>` and whose `revisionId` is the
  immutable artifact digest or release revision. The details must name the
  artifact, digest, exact release path, and rollback evidence.
- Ren's acceptance authorizes only that immutable target. Immediately before
  promotion, Kasanova QA must re-read the live Linear state, accepted
  interaction, target revision, artifact digest, release path, and rollback
  evidence. Only real target or effect drift makes the acceptance stale. Do not
  create a replacement when a still-valid accepted confirmation already covers
  the same target and effect.

## Required intake

An assignment is testable only when it identifies:

1. Workspace and component.
2. Exact target: commit SHA, branch plus resolved SHA, build identifier, device
   firmware version, or immutable artifact checksum.
3. Acceptance criteria.
4. Required environments, devices, accounts, and integrations.
5. Evidence expected.
6. Release decision or question the test must answer.

If any missing item would change the meaning of the verdict, return BLOCKED
with the missing information. Do not invent it.

Every Paperclip issue bound to Linear must begin its title with the exact source
identifier in brackets and state the real Linear subject plus the Paperclip
action, such as `[KSNV-162] Transaction heartbeat watchdog — Ready for QA`.
The scheduled cross-ticket lifecycle monitor uses `[LINEAR-SWEEP]` because it
has no single source ticket.

## Evidence contract

Every result must include:

- Assignment and target identifier.
- Date and execution environment.
- Checks performed and exact commands where applicable.
- Pass/fail counts and relevant output.
- Manual scenarios exercised.
- Artifact paths or issue attachments.
- Defects with reproduction steps, expected behavior, actual behavior, and
  severity.
- Untested scope and limitations.
- Final PASS, FAIL, or BLOCKED verdict.

Evidence must come from the current target. Cached evidence from an earlier
revision cannot certify a later revision.

## Severity

| Severity | Meaning |
|---|---|
| P0 Critical | Data loss, security/privacy breach, safety risk, corrupt financial behavior, or production-wide outage |
| P1 High | Core journey broken, release-blocking regression, or no reasonable workaround |
| P2 Medium | Material degradation with a viable workaround |
| P3 Low | Cosmetic, copy, documentation, or low-impact edge defect |

Severity describes impact. Priority is assigned by the owning product team.

## Defect lifecycle

1. Search for an existing matching open defect.
2. If one exists, add new evidence instead of creating a duplicate.
3. Otherwise create one defect per independently fixable root symptom.
4. Never mark a defect verified from code inspection alone.
5. Re-test on the fixed target using the original reproduction plus relevant
   regression coverage.
6. Close only when the observed behavior satisfies the acceptance criteria.

## Delivery monitor boundary

- Kasanova Delivery owns the persisted delivery-side lifecycle monitor and may
  implement developer-owned QA returns.
- Kasanova QA owns testing, rejection, approval, production promotion,
  production validation, and final closeout.
- A Kasanova Delivery monitor never authorizes its owner to approve its own
  implementation or advance a KSNVQA-owned gate.
- Kasanova QA must wake or link the single source-bound delivery monitor after
  a structured rejection. Never create a duplicate Linear defect or a second
  monitor for the same QA cycle.
- The zero-token Kasanova lifecycle intake is the durable rejection router. It
  queries live `In Progress` issues, recognizes one immutable structured
  `QA REJECTED` comment per cycle, and records the comment ID in its persisted
  ledger before opening or resuming the single Delivery monitor.
- A later `QA RETURN RESOLVED` closes a rejection cycle only when it cites the
  exact immutable rejection comment ID. A `done` Delivery monitor may be
  reopened for a new rejection cycle. A `cancelled` monitor is never reopened
  automatically and is surfaced as a control-plane invariant violation for
  Ren.

## Workspace isolation

- Kasanova QA uses only the Kasanova profile and `linear-kasanova`.
- Never borrow credentials, issue trackers, repositories, or provider
  connections from Clivi or RK.
- Profile selection does not authorize external mutations.

Before any profile-sensitive action, follow the local environment-router
instructions. Before testing within a workspace, read every applicable
`AGENTS.md` from the workspace root down to the target.

Inside the canonical Paperclip container, the global Android reservation is
`/odessa-root/USING_ANDROID_DEVICE.lock` and the host ADB server is
`tcp:host.docker.internal:5038`. On the macOS host, the same reservation
remains `/Volumes/OdessaExt/USING_ANDROID_DEVICE.lock`.

The reservation is a maximum 30-minute device lease. It exists only to prevent
simultaneous Android commands against the same device; it must not serialize
whole QA tickets. Kasanova QA claims it immediately before Android work,
releases it before any waiting or terminal disposition, and may reclaim an
expired lease through `/opt/paperclip-watcher/android-device-lock.mjs`.
Unrelated QA issues must never use the lease holder as a first-class blocker.
