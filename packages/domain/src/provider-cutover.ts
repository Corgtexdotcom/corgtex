/** Provider cutover record */
export type ProviderCutoverRecord={id:string;customerAccountId:string;sourceDeploymentId:string;destinationDeploymentId:string|null;sourceProvider:string;destinationProvider:string;status:string;sourceWriteStoppedAt:Date|null;destinationWriteStartedAt:Date|null;finalSnapshotAt:Date|null;finalSnapshotChecksum:string|null;sourceDataFreshThroughAt:Date|null;observationCompletedAt:Date|null;archiveRestoreTestedAt:Date|null;archiveRetentionDeadline:Date|null;retentionWaiverApprovedAt:Date|null;retentionWaiverApprovedBy:string|null;retentionWaiverReason:string|null;sourceDeletedAt:Date|null;evidence:Record<string,unknown>|null;reason:string;createdAt:Date;updatedAt:Date;};
/** Context for assessing cutover readiness */
export type CutoverAssessmentContext={assessedAt:Date;requiredSourceFreshThroughAt:Date;requiredSourceRuntimeObservedAt:Date;};
/** Readiness assessment results */
export type CutoverReadinessAssessment={rollbackReady:boolean;archiveAvailable:boolean;deleteEligible:boolean;};
/** Blocker codes */
export type CutoverBlockerCode="INVALID_IDENTITY"|"INVALID_CONTEXT"|"SOURCE_RUNTIME_DOWN"|"SOURCE_RUNTIME_UNOBSERVED"|"DESTINATION_WRITES_INCOMPATIBLE"|"SOURCE_DATA_STALE"|"OBSERVATION_BEFORE_DESTINATION_WRITES"|"MISSING_WRITE_STOP"|"MISSING_SNAPSHOT"|"MISSING_CHECKSUM"|"MALFORMED_CHECKSUM"|"MISSING_RESTORE"|"SNAPSHOT_BEFORE_STOP"|"RESTORE_BEFORE_SNAPSHOT"|"MISSING_OBSERVATION"|"WAIVER_INCOMPLETE"|"WAIVER_FUTURE"|"DEADLINE_BEFORE_SNAPSHOT"|"RETENTION_NOT_REACHED"|"CONTRADICTORY_DELETION"|"MISSING_DELETION_EVIDENCE";
/** Sanitized summary */
export type SanitizedCutoverSummary={status:string|null;sourceProvider:string|null;destinationProvider:string|null;rollbackReady:boolean;archiveAvailable:boolean;deleteEligible:boolean;observationCompletedAt:Date|null;archiveRetentionDeadline:Date|null;retentionWaiverPresent:boolean;sourceDeletedAt:Date|null;blockerCodes:CutoverBlockerCode[];};

const V_PROV=new Set(["RAILWAY","AZURE","SELF_HOSTED"]);
const V_STAT=new Set(["PLANNED","SHADOW","CUTOVER","OBSERVING","ARCHIVE_ONLY","DELETE_ELIGIBLE","DELETED","ROLLED_BACK"]);
const okD=(d:unknown):d is Date=>d instanceof Date&&!isNaN(d.getTime());
/** Assesses cutover readiness */
export function assessCutoverReadiness(r:ProviderCutoverRecord,c:CutoverAssessmentContext):{readiness:CutoverReadinessAssessment;summary:SanitizedCutoverSummary;}{
const b=new Set<CutoverBlockerCode>();
if(!okD(c.assessedAt)||!okD(c.requiredSourceFreshThroughAt)||!okD(c.requiredSourceRuntimeObservedAt)){
b.add("INVALID_CONTEXT");return fail(null,null,null,b);}
if(!V_PROV.has(r.sourceProvider)||!V_PROV.has(r.destinationProvider)||r.sourceProvider===r.destinationProvider||!V_STAT.has(r.status)){
b.add("INVALID_IDENTITY");return fail(null,null,null,b);}
const {status,sourceProvider,destinationProvider}=r;
let rr=false,aa=false,de=false;
if(["SHADOW","CUTOVER","OBSERVING"].includes(status)){
const ev=r.evidence||{},hl=ev.sourceRuntimeHealthy===true,dc=ev.destinationWritesCompatible===true;
let ot=false;
if(typeof ev.sourceRuntimeObservedAt==="string"){
const d=new Date(ev.sourceRuntimeObservedAt);
if(okD(d)&&d>=c.requiredSourceRuntimeObservedAt&&d<=c.assessedAt) ot=true;}
const fv=okD(r.sourceDataFreshThroughAt)&&r.sourceDataFreshThroughAt>=c.requiredSourceFreshThroughAt;
let co=true;
if(["CUTOVER","OBSERVING"].includes(status)&&(!okD(r.destinationWriteStartedAt)||c.requiredSourceFreshThroughAt<r.destinationWriteStartedAt)) co=false;
if(!hl)b.add("SOURCE_RUNTIME_DOWN");if(!ot)b.add("SOURCE_RUNTIME_UNOBSERVED");
if(!dc)b.add("DESTINATION_WRITES_INCOMPATIBLE");if(!fv)b.add("SOURCE_DATA_STALE");
if(!co)b.add("OBSERVATION_BEFORE_DESTINATION_WRITES");
rr=hl&&ot&&dc&&fv&&co;}
const hs=okD(r.sourceWriteStoppedAt),hsn=okD(r.finalSnapshotAt),hr=okD(r.archiveRestoreTestedAt);
const hc=typeof r.finalSnapshotChecksum==="string"&&/^[a-f0-9]{64}$/.test(r.finalSnapshotChecksum);
if(!hs)b.add("MISSING_WRITE_STOP");if(!hsn)b.add("MISSING_SNAPSHOT");
if(!hc){if(r.finalSnapshotChecksum)b.add("MALFORMED_CHECKSUM");else b.add("MISSING_CHECKSUM");}
if(!hr)b.add("MISSING_RESTORE");
if(hs&&hsn&&r.finalSnapshotAt!.getTime()<r.sourceWriteStoppedAt!.getTime())b.add("SNAPSHOT_BEFORE_STOP");
if(hsn&&hr&&r.archiveRestoreTestedAt!.getTime()<r.finalSnapshotAt!.getTime())b.add("RESTORE_BEFORE_SNAPSHOT");
if(hs&&hsn&&hc&&hr&&r.finalSnapshotAt!.getTime()>=r.sourceWriteStoppedAt!.getTime()&&r.archiveRestoreTestedAt!.getTime()>=r.finalSnapshotAt!.getTime()) aa=true;
const hd=okD(r.sourceDeletedAt);
if(status==="DELETED"){if(!hd)b.add("MISSING_DELETION_EVIDENCE");}
else if(hd)b.add("CONTRADICTORY_DELETION");
let wp=false;
if(okD(r.retentionWaiverApprovedAt)&&typeof r.retentionWaiverApprovedBy==="string"&&r.retentionWaiverApprovedBy.trim()!==""&&typeof r.retentionWaiverReason==="string"&&r.retentionWaiverReason.trim()!==""){
if(r.retentionWaiverApprovedAt>c.assessedAt)b.add("WAIVER_FUTURE");else wp=true;}
else if(r.retentionWaiverApprovedAt||r.retentionWaiverApprovedBy||r.retentionWaiverReason)b.add("WAIVER_INCOMPLETE");
if(status==="DELETE_ELIGIBLE"&&!hd){
let oc=okD(r.observationCompletedAt);
if(!oc)b.add("MISSING_OBSERVATION");
if(oc&&okD(r.destinationWriteStartedAt)&&r.observationCompletedAt!.getTime()<r.destinationWriteStartedAt.getTime()){
b.add("OBSERVATION_BEFORE_DESTINATION_WRITES");oc=false;}
let dr=false;
if(okD(r.archiveRetentionDeadline)){
if(hsn&&r.archiveRetentionDeadline!.getTime()<r.finalSnapshotAt!.getTime())b.add("DEADLINE_BEFORE_SNAPSHOT");
else if(r.archiveRetentionDeadline<=c.assessedAt)dr=true;
else b.add("RETENTION_NOT_REACHED");}
else if(!wp)b.add("RETENTION_NOT_REACHED");
if(oc&&aa&&(dr||wp))de=true;}
return{readiness:{rollbackReady:rr,archiveAvailable:aa,deleteEligible:de},summary:{status,sourceProvider,destinationProvider,rollbackReady:rr,archiveAvailable:aa,deleteEligible:de,observationCompletedAt:okD(r.observationCompletedAt)?r.observationCompletedAt:null,archiveRetentionDeadline:okD(r.archiveRetentionDeadline)?r.archiveRetentionDeadline:null,retentionWaiverPresent:wp,sourceDeletedAt:okD(r.sourceDeletedAt)?r.sourceDeletedAt:null,blockerCodes:Array.from(b).sort()}};}
function fail(s:string|null,sp:string|null,dp:string|null,b:Set<CutoverBlockerCode>){return{readiness:{rollbackReady:false,archiveAvailable:false,deleteEligible:false},summary:{status:s,sourceProvider:sp,destinationProvider:dp,rollbackReady:false,archiveAvailable:false,deleteEligible:false,observationCompletedAt:null,archiveRetentionDeadline:null,retentionWaiverPresent:false,sourceDeletedAt:null,blockerCodes:Array.from(b).sort()}};}
