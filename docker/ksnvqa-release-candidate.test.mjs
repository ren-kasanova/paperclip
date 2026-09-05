import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  candidateSummary,
  mergeGate,
  openCandidate,
  pinCandidate,
  readCandidate,
  recordCandidateMerge,
  recordCompensatingRevert,
  releaseCandidate,
  repairCandidate,
  stageCandidatePromotion,
} from "./ksnvqa-release-candidate.mjs";

const owner = {
  paperclipIssueId: "2b25831a-6390-4161-88a2-ca3947649b3b",
  paperclipIdentifier: "KSNVQA-856",
};
const otherOwner = "9eab523c-d85a-42b3-9d31-89f0f3054cff";
const tickets = ["KSNV-303"];
const source = {
  appDevSha: "24a2c051f5cb1eee1493f24055462ffe88be06f2",
  appMainSha: "43fbc1036be4a14d27f62f0026c51530491a05cb",
  coreDevSha: "2e97cf1c54ab30aedd48d04b40563f5c2c15aa4a",
  coreMainSha: "001bd2ab2cbd5107d437b4583780622750757f67",
  designDevSha: "bab10f059e2ced4c3faf9b4a499bcf59f5f656d7",
  designMainSha: "13fcb850a9b780b1d2abfe823d7fa100d16e6654",
};
const repositorySource = {
  app: { devSha: source.appDevSha, mainSha: source.appMainSha },
  core: { devSha: source.coreDevSha, mainSha: source.coreMainSha },
  design: { devSha: source.designDevSha, mainSha: source.designMainSha },
};
const mergedMain = {
  app: "b244690f04a470f8e44c71665782be0be19b0c61",
  core: "c006a625da3855ad9d1ad8e8a513815a1f3a4938",
  design: "4ab146496e158f9271affe5a5ca21f6bffa0e701",
};
const compensatingMain = {
  app: "a244690f04a470f8e44c71665782be0be19b0c62",
  core: "d006a625da3855ad9d1ad8e8a513815a1f3a4939",
  design: "5ab146496e158f9271affe5a5ca21f6bffa0e702",
};
const restoredTree = {
  app: "c8a4de53289b186153ea4e8ec12f3dc407cf7981",
  core: "1d235486ab9e33b5c702a724c91e5f2934043352",
  design: "4ec97dccce819c4cd67741cc060f707ce4be5353",
};
const timestamps = {
  opened: "2026-08-24T20:00:00.000Z",
  pinned: "2026-08-24T20:01:00.000Z",
  staged: "2026-08-24T20:02:00.000Z",
  appMerged: "2026-08-24T20:03:00.000Z",
  coreMerged: "2026-08-24T20:04:00.000Z",
  designMerged: "2026-08-24T20:05:00.000Z",
  released: "2026-08-24T20:06:00.000Z",
  repaired: "2026-08-24T20:07:00.000Z",
};

async function withLedger(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ksnvqa-candidate-"));
  const file = path.join(directory, "candidate.json");
  try {
    await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function open(file) {
  return openCandidate(
    file,
    {
      ...owner,
      tickets,
      repositoryNames: Object.keys(repositorySource),
    },
    timestamps.opened,
  );
}

async function pin(file) {
  return pinCandidate(
    file,
    {
      paperclipIssueId: owner.paperclipIssueId,
      tickets,
      source: repositorySource,
    },
    timestamps.pinned,
  );
}

async function createReleasedCandidate(file) {
  await open(file);
  await pin(file);
  await stageCandidatePromotion(
    file,
    {
      paperclipIssueId: owner.paperclipIssueId,
      promotion: {
        app: { pullRequest: "276", headSha: source.appDevSha },
        core: { pullRequest: "77", headSha: source.coreDevSha },
        design: { pullRequest: "23", headSha: source.designDevSha },
      },
    },
    timestamps.staged,
  );
  await recordCandidateMerge(
    file,
    {
      paperclipIssueId: owner.paperclipIssueId,
      repository: "app",
      headSha: source.appDevSha,
      mainSha: mergedMain.app,
    },
    timestamps.appMerged,
  );
  await recordCandidateMerge(
    file,
    {
      paperclipIssueId: owner.paperclipIssueId,
      repository: "core",
      headSha: source.coreDevSha,
      mainSha: mergedMain.core,
    },
    timestamps.coreMerged,
  );
  await recordCandidateMerge(
    file,
    {
      paperclipIssueId: owner.paperclipIssueId,
      repository: "design",
      headSha: source.designDevSha,
      mainSha: mergedMain.design,
    },
    timestamps.designMerged,
  );
  return releaseCandidate(
    file,
    { paperclipIssueId: owner.paperclipIssueId },
    timestamps.released,
  );
}

function repairInput(paperclipIssueId = owner.paperclipIssueId) {
  return {
    paperclipIssueId,
    reason: "Compensate the recorded three-repository promotion",
    rejectionId: "qa-rejected-comment-id",
    linearIdentifier: "KSNV-303",
  };
}

function compensationInput(repository, overrides = {}) {
  const targetMainSha = {
    app: source.appMainSha,
    core: source.coreMainSha,
    design: source.designMainSha,
  }[repository];
  return {
    paperclipIssueId: owner.paperclipIssueId,
    repository,
    mainSha: compensatingMain[repository],
    targetMainSha,
    treeSha: restoredTree[repository],
    ...overrides,
  };
}

test("owner-matched released candidate enters repair without losing release evidence", async () => {
  await withLedger(async (file) => {
    const released = await createReleasedCandidate(file);
    const historyBefore = await readFile(`${file}.history.jsonl`, "utf8");
    const repaired = await repairCandidate(
      file,
      repairInput(),
      timestamps.repaired,
    );

    assert.equal(repaired.status, "repairing");
    assert.deepEqual(repaired.owner, released.owner);
    assert.deepEqual(repaired.source, released.source);
    assert.equal(repaired.candidateFingerprint, released.candidateFingerprint);
    assert.deepEqual(repaired.repair.previousPromotion, released.promotion);
    assert.deepEqual(repaired.repair.compensation, {});
    assert.equal(repaired.promotion, null);
    assert.deepEqual(repaired.audit.slice(0, -1), released.audit);
    assert.deepEqual(repaired.audit.at(-1), {
      action: "repairing",
      at: timestamps.repaired,
      paperclipIssueId: owner.paperclipIssueId,
    });
    assert.equal(
      await readFile(`${file}.history.jsonl`, "utf8"),
      historyBefore,
    );
  });
});

test("successful app, core, and design compensation records preserve ancestry evidence", async () => {
  await withLedger(async (file) => {
    await createReleasedCandidate(file);
    await repairCandidate(file, repairInput(), timestamps.repaired);

    await assert.rejects(pin(file), /record every compensating revert/);
    const app = await recordCompensatingRevert(file, compensationInput("app"));
    assert.deepEqual(app.repair.compensation.app, {
      paperclipIssueId: owner.paperclipIssueId,
      repository: "app",
      revertedPromotionMainSha: mergedMain.app,
      restorationTargetMainSha: source.appMainSha,
      restoredMainSha: compensatingMain.app,
      restoredTreeSha: restoredTree.app,
      recordedAt: app.repair.compensation.app.recordedAt,
    });
    await assert.rejects(pin(file), /record every compensating revert/);
    await recordCompensatingRevert(file, compensationInput("core"));
    await assert.rejects(pin(file), /record every compensating revert/);
    const design = await recordCompensatingRevert(
      file,
      compensationInput("design"),
    );
    assert.equal(design.repair.compensationComplete, true);

    const repinned = await pin(file);
    assert.equal(repinned.status, "active");
    assert.equal(repinned.repair, null);
    assert.equal(repinned.repairHistory.length, 1);
    assert.equal(repinned.repairHistory[0].compensationComplete, true);
  });
});

test("compensation fails closed for the wrong owner or repository", async () => {
  await withLedger(async (file) => {
    await createReleasedCandidate(file);
    await repairCandidate(file, repairInput(), timestamps.repaired);
    const before = await readFile(file, "utf8");

    await assert.rejects(
      recordCompensatingRevert(
        file,
        compensationInput("app", { paperclipIssueId: otherOwner }),
      ),
      /cannot mutate it/,
    );
    await assert.rejects(
      recordCompensatingRevert(file, {
        ...compensationInput("app"),
        repository: "wallet",
      }),
      /repository must be one of: app, core, design/,
    );
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("compensation rejects the wrong historical restoration target", async () => {
  await withLedger(async (file) => {
    await createReleasedCandidate(file);
    await repairCandidate(file, repairInput(), timestamps.repaired);
    const before = await readFile(file, "utf8");

    await assert.rejects(
      recordCompensatingRevert(
        file,
        compensationInput("app", { targetMainSha: source.coreMainSha }),
      ),
      /does not match pre-candidate main/,
    );
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("compensation rejects reuse of the promoted main SHA", async () => {
  await withLedger(async (file) => {
    await createReleasedCandidate(file);
    await repairCandidate(file, repairInput(), timestamps.repaired);
    const before = await readFile(file, "utf8");

    await assert.rejects(
      recordCompensatingRevert(
        file,
        compensationInput("app", { mainSha: mergedMain.app }),
      ),
      /must differ from promoted main/,
    );
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("compensation rejects reuse of the historical restoration target as main", async () => {
  await withLedger(async (file) => {
    await createReleasedCandidate(file);
    await repairCandidate(file, repairInput(), timestamps.repaired);
    const before = await readFile(file, "utf8");

    await assert.rejects(
      recordCompensatingRevert(
        file,
        compensationInput("app", { mainSha: source.appMainSha }),
      ),
      /must differ from historical restoration target/,
    );
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("identical compensation retries are idempotent and drift fails closed", async () => {
  await withLedger(async (file) => {
    await createReleasedCandidate(file);
    await repairCandidate(file, repairInput(), timestamps.repaired);
    const first = await recordCompensatingRevert(
      file,
      compensationInput("app"),
      "2026-08-24T20:08:00.000Z",
    );
    const persisted = await readFile(file, "utf8");
    const repeated = await recordCompensatingRevert(
      file,
      compensationInput("app"),
      "2026-08-24T20:09:00.000Z",
    );
    assert.deepEqual(repeated, first);
    assert.equal(await readFile(file, "utf8"), persisted);

    for (const overrides of [
      { mainSha: compensatingMain.core },
      { targetMainSha: source.coreMainSha },
      { treeSha: restoredTree.core },
    ]) {
      await assert.rejects(
        recordCompensatingRevert(file, compensationInput("app", overrides)),
        /different app compensation evidence|does not match pre-candidate main/,
      );
      assert.equal(await readFile(file, "utf8"), persisted);
    }
  });
});

test("incomplete compensation records cannot satisfy compensationComplete", async () => {
  await withLedger(async (file) => {
    await createReleasedCandidate(file);
    await repairCandidate(file, repairInput(), timestamps.repaired);
    for (const repository of ["app", "core", "design"]) {
      await recordCompensatingRevert(file, compensationInput(repository));
    }
    const candidate = await readCandidate(file);
    delete candidate.repair.compensation.design.restoredTreeSha;
    candidate.repair.compensationComplete = true;
    await writeFile(file, `${JSON.stringify(candidate, null, 2)}\n`);

    await assert.rejects(pin(file), /record every compensating revert/);
  });
});

test("released repair fails closed for a different owner without changing the ledger", async () => {
  await withLedger(async (file) => {
    await createReleasedCandidate(file);
    const before = await readFile(file, "utf8");

    await assert.rejects(
      repairCandidate(file, repairInput(otherOwner), timestamps.repaired),
      /cannot mutate it/,
    );
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("released repair fails closed for unrecorded or invalid release evidence", async () => {
  await withLedger(async (file) => {
    const released = await createReleasedCandidate(file);
    const invalidCandidates = [
      { ...released, promotion: null },
      {
        ...released,
        promotion: {
          ...released.promotion,
          design: { ...released.promotion.design, mergedMainSha: null },
        },
      },
      { ...released, candidateFingerprint: "0".repeat(64) },
    ];

    for (const candidate of invalidCandidates) {
      await writeFile(file, `${JSON.stringify(candidate, null, 2)}\n`);
      const before = await readFile(file, "utf8");
      await assert.rejects(
        repairCandidate(file, repairInput(), timestamps.repaired),
      );
      assert.equal(await readFile(file, "utf8"), before);
    }
  });
});

test("repeating the same repair is idempotent for the owner and context", async () => {
  await withLedger(async (file) => {
    await createReleasedCandidate(file);
    const first = await repairCandidate(
      file,
      repairInput(),
      timestamps.repaired,
    );
    const persistedAfterFirst = await readFile(file, "utf8");
    const second = await repairCandidate(
      file,
      repairInput(),
      "2026-08-24T20:08:00.000Z",
    );

    assert.deepEqual(second, first);
    assert.equal(await readFile(file, "utf8"), persistedAfterFirst);
  });
});

test("preparing, active, and repairing candidates retain their repair behavior", async () => {
  await withLedger(async (preparingFile) => {
    await open(preparingFile);
    const preparingRepair = await repairCandidate(
      preparingFile,
      repairInput(),
      timestamps.repaired,
    );
    assert.equal(preparingRepair.status, "repairing");
    assert.equal(preparingRepair.repair.previousPromotion, null);
  });

  await withLedger(async (activeFile) => {
    await open(activeFile);
    await pin(activeFile);
    const activeRepair = await repairCandidate(
      activeFile,
      repairInput(),
      timestamps.repaired,
    );
    assert.equal(activeRepair.status, "repairing");
    assert.equal(activeRepair.repair.previousPromotion, null);

    const changed = await repairCandidate(
      activeFile,
      { ...repairInput(), reason: "A newer repair reason" },
      "2026-08-24T20:09:00.000Z",
    );
    assert.equal(changed.repair.reason, "A newer repair reason");
    assert.equal(changed.repair.enteredAt, timestamps.repaired);
    assert.equal(changed.audit.length, activeRepair.audit.length + 1);
  });
});

test("backend-only ticket candidate pins Sterling and omits client repositories", async () => {
  await withLedger(async (file) => {
    const backendSource = {
      sterling: {
        devSha: "1971971971971971971971971971971971971971",
        mainSha: "1971971971971971971971971971971971971970",
      },
    };
    const opened = await openCandidate(
      file,
      {
        ...owner,
        tickets: ["KSNV-197"],
        repositoryNames: ["sterling"],
      },
      "2026-09-05T00:00:00.000Z",
    );
    assert.notEqual(opened.batchId, "ksnvqa-20260904135425-94afcbc3");

    const pinned = await pinCandidate(file, {
      paperclipIssueId: owner.paperclipIssueId,
      tickets: ["KSNV-197"],
      source: backendSource,
    });
    assert.deepEqual(pinned.repositoryNames, ["sterling"]);
    assert.deepEqual(pinned.source, backendSource);
    assert.equal(pinned.source.app, undefined);
    assert.equal(pinned.source.core, undefined);
    assert.equal(pinned.source.design, undefined);

    await stageCandidatePromotion(file, {
      paperclipIssueId: owner.paperclipIssueId,
      promotion: {
        sterling: { pullRequest: "197", headSha: backendSource.sterling.devSha },
      },
    });
    await recordCandidateMerge(file, {
      paperclipIssueId: owner.paperclipIssueId,
      repository: "sterling",
      headSha: backendSource.sterling.devSha,
      mainSha: "1971971971971971971971971971971971971972",
    });
    const released = await releaseCandidate(file, {
      paperclipIssueId: owner.paperclipIssueId,
    });
    assert.deepEqual(candidateSummary(released).repositories.map(({ repository }) => repository), [
      "sterling",
    ]);
  });
});

test("candidate scope rejects repository drift and gates only pinned repositories", async () => {
  await withLedger(async (file) => {
    const opened = await openCandidate(file, {
      ...owner,
      tickets: ["KSNV-197"],
      repositoryNames: ["sterling"],
    });
    assert.equal(mergeGate(opened, "feature", "sterling").allowed, false);
    assert.equal(mergeGate(opened, "feature", "app").allowed, true);
    assert.equal(mergeGate(opened, "promotion", "sterling").allowed, true);

    await assert.rejects(
      pinCandidate(file, {
        paperclipIssueId: owner.paperclipIssueId,
        tickets: ["KSNV-197"],
        source: repositorySource,
      }),
      /must exactly match candidate scope: sterling/,
    );
  });
});

test("candidate open rejects ticket batching", async () => {
  await withLedger(async (file) => {
    await assert.rejects(
      openCandidate(file, {
        ...owner,
        tickets: ["KSNV-197", "KSNV-303"],
        repositoryNames: ["sterling"],
      }),
      /exactly one KSNV ticket/,
    );
  });
});

test("the focused test fixture leaves no live candidate mutation behind", async () => {
  await withLedger(async (file) => {
    assert.equal(await readCandidate(file), null);
  });
});
