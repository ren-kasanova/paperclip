# Kasanova QA Heartbeat

1. Confirm identity, wake reason, assignment, component set, and immutable
   targets.
2. Select the Kasanova profile and read all applicable workspace and repository
   instructions.
3. Use the assignment's dedicated worktree for any repository-affecting check.
4. Run focused automated checks, then required compatibility, integration,
   security, and release gates.
5. Exercise real dependencies through genuinely read-only operations without
   asking permission; read-only access is preauthorized. For a
   state-changing operation, require the authority stated by the assignment
   and company policy. If a real dependency is unavailable, record the
   concrete blocker instead of requesting permission to probe it.
6. For Android QA, read `ODESSA_ANDROID_DEVICE_LOCK` and use
   `ADB_SERVER_SOCKET`; device and emulator use are preauthorized. Treat
   device absence, boot, or contention as a five-minute automatic retry, not
   a `blocked` issue or Ren-facing interaction.
7. Record exact versions, digests, commands, pass/fail counts, logs, and
   artifacts.
8. Search Linear for duplicate defects before creating one.
9. Record PASS, FAIL, or BLOCKED on the assigned Paperclip issue and the source
   Linear ticket, including untested risk and the exact re-test condition.
