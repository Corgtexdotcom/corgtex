import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRecorderProviderWire, prepareRecorderTranscript, publishRecorderTranscript, withRecorderTranscriptAttempt } from "./recorder-transcript-input";
import { getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { classifyInformationSource, configureInformationCategory } from "./information-category-policy";
import { captureArtifactInputProof, isArtifactInputProofReadable, isArtifactInputProofPubliclyShareable, lineageContentFingerprint, recordArtifactInputLineage, type LineageInput } from "./source-lineage";
const db = getPrismaClient();
beforeEach(async () => {await truncateAllTables();});
afterAll(() => vi.unstubAllEnvs());
describe("company category current and original authority", () => {
  it.each(["BrainSource", "Document", "Meeting"] as const)("binds %s to any company category without admin bypass or old-proof revival", async kind => {
    const workspace = await db.workspace.create({data: {slug: `category-${kind}`, name: "Synthetic category"}});
    const users = await Promise.all(["allowed", "ordinary"].map(name => db.user.create({data: {email: `${name}@category.test`, displayName: name, passwordHash: "synthetic"}})));
    const members = await Promise.all(users.map(user => db.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}})));
    const owner: AppActor = {kind: "user", user: users[0]}, other: AppActor = {kind: "user", user: users[1]};
    const circle = await db.circle.create({data: {workspaceId: workspace.id, name: "Selected circle"}});
    const role = await db.role.create({data: {circleId: circle.id, name: "Selected role", accountabilities: [], artifacts: []}});
    const assignment = await db.roleAssignment.create({data: {roleId: role.id, memberId: members[0].id}});
    const source = kind === "BrainSource" ? await db.brainSource.create({data: {workspaceId: workspace.id, sourceType: "ARTICLE", tier: 1, content: "Synthetic company fact"}})
      : kind === "Document" ? await db.document.create({data: {workspaceId: workspace.id, title: "Synthetic document", source: "human", storageKey: "synthetic", textContent: "Synthetic company fact"}})
      : await db.meeting.create({data: {workspaceId: workspace.id, title: "Synthetic meeting", source: "human", recordedAt: new Date(), transcript: "Synthetic company fact", participantIds: []}});
    const input: LineageInput = {kind, id: source.id};
    await db.$transaction(tx => recordArtifactInputLineage({tx, actor: owner, workspaceId: workspace.id, artifact: input, content: source, origin: "HUMAN_ORIGINAL", inputs: []}));
    await configureInformationCategory(owner, {workspaceId: workspace.id, category: "SALARY", isRestricted: false, allowedRoleIds: [], allowedCircleIds: []});
    const originalHash = lineageContentFingerprint(kind, source);
    const originalManifests = await db.artifactInputLineage.findMany({where: {workspaceId: workspace.id, artifactType: kind, artifactId: source.id}});
    await classifyInformationSource(owner, {workspaceId: workspace.id, ...input, kind, category: "SALARY"});
    const classified = kind === "BrainSource" ? await db.brainSource.findUniqueOrThrow({where: {id: source.id}})
      : kind === "Document" ? await db.document.findUniqueOrThrow({where: {id: source.id}})
      : await db.meeting.findUniqueOrThrow({where: {id: source.id}});
    expect(classified.informationCategory).toBe("SALARY");
    expect(lineageContentFingerprint(kind, classified)).toBe(originalHash);
    expect(await db.artifactInputLineage.findMany({where: {workspaceId: workspace.id, artifactType: kind, artifactId: source.id}})).toEqual(originalManifests);
    // Human originals remain readable under their current policy; derived saved proofs never refresh.
    const before = await captureArtifactInputProof(owner, workspace.id, [input]);
    expect(await isArtifactInputProofReadable(other, workspace.id, before)).toBe(true);
    await configureInformationCategory(owner, {workspaceId: workspace.id, category: "SALARY", isRestricted: true, allowedRoleIds: [], allowedCircleIds: [circle.id]});
    expect(await isArtifactInputProofReadable(other, workspace.id, before)).toBe(false);
    expect(await isArtifactInputProofReadable(owner, workspace.id, before)).toBe(false);
    const current = await captureArtifactInputProof(owner, workspace.id, [input]);
    expect(await isArtifactInputProofReadable(owner, workspace.id, current)).toBe(true);
    expect(await isArtifactInputProofReadable(other, workspace.id, current)).toBe(false);
    expect(await isArtifactInputProofPubliclyShareable(owner, workspace.id, current)).toBe(false);
    await db.roleAssignment.delete({where: {id: assignment.id}});
    expect(await isArtifactInputProofReadable(owner, workspace.id, current)).toBe(false);
    await db.roleAssignment.create({data: {roleId: role.id, memberId: members[0].id}});
    expect(await isArtifactInputProofReadable(owner, workspace.id, current)).toBe(false);
    await configureInformationCategory(owner, {workspaceId: workspace.id, category: "SALARY", isRestricted: false, allowedRoleIds: [], allowedCircleIds: []});
    expect(await isArtifactInputProofReadable(other, workspace.id, before)).toBe(false);
    expect(await isArtifactInputProofReadable(other, workspace.id, current)).toBe(false);
    expect(await captureArtifactInputProof(other, workspace.id, [input])).not.toHaveLength(0);
  });
  it.each(["BrainSource", "Document", "Meeting"] as const)("rejects unknown and cross-company category bindings for %s without changing source authority", async kind => {
    const workspace = await db.workspace.create({data: {slug: `category-binding-${kind}`, name: "Synthetic binding"}});
    const foreign = await db.workspace.create({data: {slug: `foreign-binding-${kind}`, name: "Other company"}});
    const user = await db.user.create({data: {email: "binding@category.test", passwordHash: "synthetic"}});
    await db.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
    const actor: AppActor = {kind: "user", user};
    const source = kind === "BrainSource" ? await db.brainSource.create({data: {workspaceId: workspace.id, sourceType: "ARTICLE", tier: 1, content: "Synthetic company fact"}})
      : kind === "Document" ? await db.document.create({data: {workspaceId: workspace.id, title: "Synthetic document", source: "human", storageKey: "synthetic", textContent: "Synthetic company fact"}})
      : await db.meeting.create({data: {workspaceId: workspace.id, title: "Synthetic meeting", source: "human", recordedAt: new Date(), transcript: "Synthetic company fact", participantIds: []}});
    const request = {workspaceId: workspace.id, kind, id: source.id};
    await expect(classifyInformationSource(actor, {...request, category: "GENERAL"})).resolves.toMatchObject({informationCategory: "GENERAL"});
    await configureInformationCategory(actor, {workspaceId: workspace.id, category: "SALARY", isRestricted: true, allowedRoleIds: [], allowedCircleIds: []});
    await classifyInformationSource(actor, {...request, category: "SALARY"});
    await db.informationCategoryPolicy.create({data: {workspaceId: foreign.id, category: "FOREIGN", isRestricted: false}});
    const readSource = () => kind === "BrainSource" ? db.brainSource.findUniqueOrThrow({where: {id: source.id}})
      : kind === "Document" ? db.document.findUniqueOrThrow({where: {id: source.id}}) : db.meeting.findUniqueOrThrow({where: {id: source.id}});
    const before = await readSource();
    const epochs = await db.sourcePermissionEpoch.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}});
    for (const category of ["SALLARY", "FOREIGN"]) {
      await expect(classifyInformationSource(actor, {...request, category})).rejects.toMatchObject({code: "UNKNOWN_INFORMATION_CATEGORY"});
      expect(await readSource()).toEqual(before);
      expect(await db.sourcePermissionEpoch.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}})).toEqual(epochs);
    }
  });
  it.each([false, true])("withholds authentic recorder parents after restriction and restoration (restricted at capture=%s)", async restrictedAtCapture => {
    vi.stubEnv("RECALL_API_KEY", "synthetic-recall-key"); vi.stubEnv("RECALL_REGION", "us-west-2");
    vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", undefined);
    const workspace = await db.workspace.create({data: {slug: "category-recorder", name: "Synthetic recorder category"}});
    const user = await db.user.create({data: {email: "recorder@category.test", displayName: "Recorder member", passwordHash: "synthetic"}});
    await db.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
    const actor: AppActor = {kind: "user", user};
    const meeting = await db.meeting.create({data: {workspaceId: workspace.id, title: "Synthetic meeting", source: "manual",
      informationCategory: "SALARY", recordedAt: new Date(Date.now()-7200000), scheduledEndAt: new Date(Date.now()-3600000), status: "SCHEDULED"}});
    await db.$transaction(tx => recordArtifactInputLineage({tx, actor, workspaceId: workspace.id, artifact: {kind: "Meeting", id: meeting.id},
      content: meeting, origin: "HUMAN_ORIGINAL", inputs: []}));
    await db.workspaceMeetingRecorderConfig.create({data: {workspaceId: workspace.id, enabled: true}});
    const recording = await db.meetingRecording.create({data: {workspaceId: workspace.id, meetingId: meeting.id, provider: "RECALL_AI",
      externalBotId: `synthetic-${randomUUID()}`, meetingUrl: "https://meet.google.com/synthetic", status: "COMPLETED"}});
    const ordinary = await db.user.create({data: {email: "ordinary-recorder@category.test", passwordHash: "synthetic"}});
    await db.member.create({data: {workspaceId: workspace.id, userId: ordinary.id}});
    const ordinaryActor: AppActor = {kind: "user", user: ordinary};
    if (restrictedAtCapture) {
      const circle = await db.circle.create({data: {workspaceId: workspace.id, name: "Recorder audience"}});
      const role = await db.role.create({data: {circleId: circle.id, name: "Recorder reader", accountabilities: [], artifacts: []}});
      const member = await db.member.findFirstOrThrow({where: {workspaceId: workspace.id, userId: user.id}});
      await db.roleAssignment.create({data: {roleId: role.id, memberId: member.id}});
      await configureInformationCategory(actor, {workspaceId: workspace.id, category: "SALARY", isRestricted: true,
        allowedRoleIds: [role.id], allowedCircleIds: []});
    }
    const transcriptPayload = [{speaker: "Synthetic", start: 0, text: "Synthetic restricted meeting text"}];
    await withRecorderTranscriptAttempt(recording, null, async receipt => {
      captureRecorderProviderWire(`https://us-west-2.recall.ai/api/v1/bot/${recording.externalBotId}/transcript/`,
        {headers: {Authorization: "Token synthetic-recall-key"}}, 200, JSON.stringify(transcriptPayload));
      return publishRecorderTranscript(await prepareRecorderTranscript(receipt, {transcriptPayload, metadata: {}}, {}));
    });
    const native = await db.nativeTranscriptInput.findFirstOrThrow({where: {workspaceId: workspace.id, mode: "RECORDER"}});
    const transcriptProof = await captureArtifactInputProof(actor, workspace.id, [{kind: "MeetingTranscript", id: meeting.id}]);
    const nativeProof = await captureArtifactInputProof(actor, workspace.id, [{kind: "NativeTranscriptInput", id: native.id}]);
    expect(await isArtifactInputProofReadable(actor, workspace.id, transcriptProof)).toBe(true);
    expect(await isArtifactInputProofReadable(actor, workspace.id, nativeProof)).toBe(true);
    expect(await isArtifactInputProofReadable(ordinaryActor, workspace.id, nativeProof)).toBe(!restrictedAtCapture);
    await configureInformationCategory(actor, {workspaceId: workspace.id, category: "SALARY", isRestricted: true, allowedRoleIds: [], allowedCircleIds: []});
    expect(await isArtifactInputProofReadable(actor, workspace.id, transcriptProof)).toBe(false);
    expect(await isArtifactInputProofReadable(actor, workspace.id, nativeProof)).toBe(false);
    await configureInformationCategory(actor, {workspaceId: workspace.id, category: "SALARY", isRestricted: false, allowedRoleIds: [], allowedCircleIds: []});
    expect(await isArtifactInputProofReadable(actor, workspace.id, transcriptProof)).toBe(false);
    expect(await isArtifactInputProofReadable(actor, workspace.id, nativeProof)).toBe(false);
    expect((await db.nativeTranscriptInput.findUniqueOrThrow({where: {id: native.id}})).encryptedPayloadJson).toBe(native.encryptedPayloadJson);
  }, 120_000);

});
