# Event-driven Kasanova QA lifecycle monitor

Linear lifecycle transitions wake KSNVQA through the zero-token intake agent. The
scheduled routine is an every-eight-hours fallback, not permission to run
continuously.
`/Volumes/OdessaExt/Kasanova/LINEAR_WORKFLOW.md` is the source of truth.

## Each scheduled run

1. Run from `/Volumes/OdessaExt/Kasanova` and select the Kasanova profile.
2. Read `LINEAR_WORKFLOW.md` before querying or changing any issue.
3. Require the exact `linear-kasanova` connection. Query all tickets whose live
   state is exactly `Ready for QA`, `Ready for Release`, `Production
   Validation`, or `Done`. Serialize Linear MCP calls; never issue them
   concurrently. Complete or fail one bounded request before starting the
   next.
4. Compare the live set and each ticket's state, updated time, acceptance
   criteria, linked changes, deployment identifiers, and latest QA evidence
   with the preceding routine executions. Never infer state from a stale local
   ledger.
5. If nothing entered or materially changed in a monitored state, publish a
   concise `Kasanova lifecycle — unchanged` result on the routine execution
   issue and stop. Do not run repository, GitHub, build, device, deployment, or
   provider checks.
6. Run only the gate matching each ticket's live state:
   - `Ready for QA`: require the development artifact and execute real TN10
     acceptance and regression checks. PASS advances to `Ready for Release`;
     rejection preserves the assignee, posts exactly one structured
     `QA REJECTED` comment, returns the same issue to `In Progress`, and wakes
     the single linked `[KSNV-###] Delivery QA-return monitor`.
   - `Ready for Release`: require the exact QA-approved artifact, TN10
     evidence, rollout and rollback evidence; promote through the existing
     authorized production release path; record immutable deployment evidence;
     then advance to `Production Validation`. Routine reviewed merges,
     standing-policy scheduled releases, exact-artifact promotions, and
     evidence-based Linear transitions require no per-run Ren confirmation. A
     blocker or implementation change returns the issue to `In Progress`.
   - `Production Validation`: gather direct production evidence for every
     acceptance criterion plus health/regression evidence. PASS advances to
     `Done`; failure or remaining implementation work returns the issue to `In
     Progress`.
   - `Done`: audit TN10 evidence, production evidence, acceptance criteria, and
     the absence of unresolved work. Missing production evidence returns the
     issue to `Production Validation`; unresolved implementation work returns
     it to `In Progress`.
7. For each gate that executes:
   - resolve every linked repository and PR through the Kasanova-routed GitHub
     identity from the canonical workspace;
   - identify the exact commit/build/artifact under test;
   - record commands, versions, immutable identifiers, outputs, and a
     PASS/FAIL/BLOCKED verdict on both the routine execution issue and the
     Linear ticket;
8. Never skip directly from `Ready for QA` to `Production Validation` or
   `Done`. Preserve `Canceled` and `Duplicate` as terminal alternatives.
9. A QA-side blocker edge does not replace the delivery monitor. On every
   accepted QA cycle, require one eligible delivery monitor assigned to
   Kasanova Delivery, with no user assignee, `in_progress` or `in_review`
   status, and a non-null `monitorNextCheckAt`.
10. Create a production-promotion confirmation only for a freeze change,
    emergency/manual/out-of-cadence release, policy exception, or materially
    new irreversible production effect outside standing policy. Bind that
    exceptional confirmation to the exact approved artifact with a custom key
    `KSNV-###:production-promotion:<exact-release-path>` and immutable
    `target.revisionId`. Re-read the live state, accepted interaction, digest,
    release path, and rollback evidence immediately before promotion. Only real
    target or effect drift requires a new confirmation; do not replace a
    still-valid accepted confirmation for the same target and effect.

## Hard limits

- Use only the Kasanova profile and `linear-kasanova`; never use Clivi or RK
  credentials.
- Never authenticate, reauthenticate, switch accounts, or borrow credentials.
- Do not use any browser, web search, Playwright, Chrome, Safari, Browser
  Plugin, open URLs, or browser/GUI web automation unless Ren's current
  message explicitly says `USA EL NAVEGADOR`.
- Every genuinely read-only operation is preauthorized. Execute reads,
  inspections, listings, queries, status and availability checks, evidence
  capture, and non-mutating `GET`, `HEAD`, or `OPTIONS` requests directly.
  Never create an approval, `request_confirmation`, `ask_user_questions`, or
  other Ren-facing interaction for a read-only operation. The browser
  prohibition above remains in force.
- Probe configured dependencies first. Request provisioning only after a real
  read-only probe proves that a credential, account, device, fixture, or
  service is missing and Ren must supply it; never request permission to run
  the probe.
- Emulator and real Android-device use are preauthorized for assigned QA,
  including installing the assigned signed QA build and exercising TN10
  fixtures. Probe availability first and request only missing provisioning
  details.
- Resolve the Android lock from `ODESSA_ANDROID_DEVICE_LOCK` and ADB from
  `ADB_SERVER_SOCKET`. Do not create an interaction to authorize device use.
- Every Ren-facing interaction must name a concrete state-changing,
  provisioning, destructive, financial, security-sensitive, publication,
  merge, deployment, or production effect. An interaction cannot authorize a
  read, a device probe/use, or browser access.
- The `0.5.0+160` freeze blocks store/OTA execution and version/build
  advancement, not ordinary reviewed merges. After the freeze is explicitly
  lifted, policy-compliant scheduled releases and exact-artifact promotions
  are standing-authorized. Granting or changing credentials, secrets,
  accounts, or security-sensitive access remains separately
  approval-controlled.
- Route every actually required approval or confirmation for a
  state-changing, destructive, financial, security-sensitive, publication,
  merge, deployment, or production operation to Ren through a first-class
  Paperclip interaction. Never resolve it on his behalf.
- Never use mocks, stubs, simulated integrations, fabricated responses, demo
  substitutes, or fallback paths.
- Do not merge, publish packages, submit transactions, move funds, modify
  source code, or mutate production outside the exact `Ready for Release`
  promotion assignment. Promotion is limited to the QA-approved artifact and
  existing release path. Policy-compliant promotion requires no Paperclip
  confirmation; exceptional approvals defined above are routed to Ren.
- Keep canonical checkouts clean. Any check that writes source or generated
  artifacts requires an explicitly assigned dedicated QA worktree.
