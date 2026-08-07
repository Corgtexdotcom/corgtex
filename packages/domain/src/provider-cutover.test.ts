import{describe,it,expect}from"vitest";import{assessCutoverReadiness,ProviderCutoverRecord,CutoverAssessmentContext}from"./provider-cutover";
const md=new Date("2026-08-07T12:00:00.000Z"),ed=new Date(md.getTime()-100000),ld=new Date(md.getTime()+100000),fd=new Date(md.getTime()+99999999);
const vc="1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const br=(o:Partial<ProviderCutoverRecord>={}):ProviderCutoverRecord=>({id:"r-1",customerAccountId:"a-1",sourceDeploymentId:"s-1",destinationDeploymentId:"d-1",sourceProvider:"AZURE",destinationProvider:"RAILWAY",status:"PLANNED",sourceWriteStoppedAt:null,destinationWriteStartedAt:null,finalSnapshotAt:null,finalSnapshotChecksum:null,sourceDataFreshThroughAt:null,observationCompletedAt:null,archiveRestoreTestedAt:null,archiveRetentionDeadline:null,retentionWaiverApprovedAt:null,retentionWaiverApprovedBy:null,retentionWaiverReason:null,sourceDeletedAt:null,evidence:null,reason:"Test",createdAt:ed,updatedAt:ed,...o});
const bc:CutoverAssessmentContext={assessedAt:md,requiredSourceFreshThroughAt:md,requiredSourceRuntimeObservedAt:md};
describe("PCO",()=>{
it("id",()=>{
expect(assessCutoverReadiness(br({sourceProvider:"UNKNOWN"}),bc).summary.blockerCodes).toContain("INVALID_IDENTITY");
expect(assessCutoverReadiness(br({sourceProvider:"AZURE",destinationProvider:"AZURE"}),bc).summary.blockerCodes).toContain("INVALID_IDENTITY");
expect(assessCutoverReadiness(br({status:"MAGIC"}),bc).summary.blockerCodes).toContain("INVALID_IDENTITY");});
it("ctx",()=>{expect(assessCutoverReadiness(br(),{...bc,assessedAt:"x"as any}).summary.blockerCodes).toContain("INVALID_CONTEXT");});
describe("Roll",()=>{
const vr=br({status:"SHADOW",sourceDataFreshThroughAt:md,evidence:{sourceRuntimeHealthy:true,destinationWritesCompatible:true,sourceRuntimeObservedAt:md.toISOString()}});
it("acpt",()=>{expect(assessCutoverReadiness(vr,bc).readiness.rollbackReady).toBe(true);});
it("rej",()=>{
expect(assessCutoverReadiness(br({...vr,evidence:{...vr.evidence!,sourceRuntimeHealthy:false}}),bc).summary.blockerCodes).toContain("SOURCE_RUNTIME_DOWN");
expect(assessCutoverReadiness(br({...vr,evidence:{...vr.evidence!,destinationWritesCompatible:false}}),bc).summary.blockerCodes).toContain("DESTINATION_WRITES_INCOMPATIBLE");
expect(assessCutoverReadiness(br({...vr,evidence:{...vr.evidence!,sourceRuntimeObservedAt:ed.toISOString()}}),bc).summary.blockerCodes).toContain("SOURCE_RUNTIME_UNOBSERVED");
expect(assessCutoverReadiness(br({...vr,sourceDataFreshThroughAt:ed}),bc).summary.blockerCodes).toContain("SOURCE_DATA_STALE");
expect(assessCutoverReadiness(br({...vr,status:"CUTOVER",destinationWriteStartedAt:ld}),bc).summary.blockerCodes).toContain("OBSERVATION_BEFORE_DESTINATION_WRITES");});});
describe("Arch",()=>{
const va=br({sourceWriteStoppedAt:ed,finalSnapshotAt:ed,finalSnapshotChecksum:vc,archiveRestoreTestedAt:md});
it("acpt",()=>{
expect(assessCutoverReadiness(va,bc).readiness.archiveAvailable).toBe(true);
expect(assessCutoverReadiness(br({...va,status:"ARCHIVE_ONLY",evidence:{sourceRuntimeHealthy:false}}),bc).readiness.archiveAvailable).toBe(true);});
it("rej",()=>{
expect(assessCutoverReadiness(br({...va,sourceWriteStoppedAt:null}),bc).summary.blockerCodes).toContain("MISSING_WRITE_STOP");
expect(assessCutoverReadiness(br({...va,finalSnapshotChecksum:"bad"}),bc).summary.blockerCodes).toContain("MALFORMED_CHECKSUM");
expect(assessCutoverReadiness(br({...va,finalSnapshotAt:ed,sourceWriteStoppedAt:md}),bc).summary.blockerCodes).toContain("SNAPSHOT_BEFORE_STOP");
expect(assessCutoverReadiness(br({...va,archiveRestoreTestedAt:ed,finalSnapshotAt:md}),bc).summary.blockerCodes).toContain("RESTORE_BEFORE_SNAPSHOT");});});
describe("Del",()=>{
const vd=br({sourceWriteStoppedAt:ed,finalSnapshotAt:ed,finalSnapshotChecksum:vc,archiveRestoreTestedAt:md,observationCompletedAt:ed,destinationWriteStartedAt:ed,status:"DELETE_ELIGIBLE",archiveRetentionDeadline:ed});
it("acpt",()=>{expect(assessCutoverReadiness(vd,bc).readiness.deleteEligible).toBe(true);
expect(assessCutoverReadiness(br({...vd,archiveRetentionDeadline:null,retentionWaiverApprovedAt:ed,retentionWaiverApprovedBy:"u1",retentionWaiverReason:"y"}),bc).readiness.deleteEligible).toBe(true);});
it("rej",()=>{
expect(assessCutoverReadiness(br({...vd,archiveRetentionDeadline:null,retentionWaiverApprovedAt:fd,retentionWaiverApprovedBy:"u",retentionWaiverReason:"y"}),bc).summary.blockerCodes).toContain("WAIVER_FUTURE");
expect(assessCutoverReadiness(br({...vd,archiveRetentionDeadline:null,retentionWaiverApprovedAt:ed,retentionWaiverApprovedBy:"u"}),bc).summary.blockerCodes).toContain("WAIVER_INCOMPLETE");
expect(assessCutoverReadiness(br({...vd,observationCompletedAt:null}),bc).summary.blockerCodes).toContain("MISSING_OBSERVATION");
expect(assessCutoverReadiness(br({...vd,archiveRetentionDeadline:fd}),bc).summary.blockerCodes).toContain("RETENTION_NOT_REACHED");
expect(assessCutoverReadiness(br({status:"DELETED"}),bc).summary.blockerCodes).toContain("MISSING_DELETION_EVIDENCE");
expect(assessCutoverReadiness(br({status:"DELETE_ELIGIBLE",sourceDeletedAt:ed}),bc).summary.blockerCodes).toContain("CONTRADICTORY_DELETION");});});
it("redacts",()=>{const r=assessCutoverReadiness(br({id:"sec-id",evidence:{k:"sec-val"},reason:"f",retentionWaiverReason:"b"}),bc);
const s=JSON.stringify(r.summary);expect(s).not.toContain("sec");expect(s).not.toContain("f");expect(s).not.toContain("b");});});
