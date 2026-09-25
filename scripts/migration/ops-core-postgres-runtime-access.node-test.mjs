import test from "node:test";
import assert from "node:assert/strict";
import { validatePostgresRuntimeAccessPolicy, validatePostgresRuntimeAccessIntent, postgresRuntimeAccessPolicySha256 as hash,
  AZURE_RUNTIME_ACCESS_SETTINGS,
  postgresRuntimeAccessIsolationInventory, preparePostgresRuntimeAccess, preparePostgresRuntimeAccessPreflight,
  applyPostgresRuntimeAccess,reconcilePostgresRuntimeAccess,monitorPostgresRuntimeAccessDrift } from "./ops-core-postgres-runtime-access.mjs";

const grant=(grantor,grantee,privilege,grantable=false)=>({grantor,grantee,privilege,grantable});
const acl=(oid,privileges)=>privileges.map(p=>grant(oid,oid,p));
const role=(name,oid,extra={})=>({name,oid,superuser:false,createDb:false,createRole:false,inherit:false,login:true,replication:false,bypassRls:false,connectionLimit:-1,...extra});
function fixture() {
  const admin="fixture_admin", runtime="corgtex_ops_runtime",scaler="worker_scale_ops",host="localhost",port=5432,database="corgtex_ops";
  const runtimePassword="ab".repeat(32),scalerPassword="cd".repeat(32),vault="https://fixture-runtime.vault.azure.net/";
  const policy={schemaVersion:1,runtimeRole:runtime,runtimeDatabaseSecrets:{web:vault+"secrets/web/"+"a".repeat(32),worker:vault+"secrets/worker/"+"b".repeat(32)},
    scaler:{role:scaler,connectionSecretVersion:vault+"secrets/scaler/"+"c".repeat(32)},applicationSchema:"public",isolation:{inventorySha256:"0".repeat(64),databases:[]}};
  const db=(name,oid)=>({name,oid,owner:admin,allowConnections:true,isTemplate:false,ownerAuthority:true,acl:acl("10",["CONNECT","CREATE","TEMPORARY"])});
  let catalog={schemaVersion:1,identity:{database,administrator:admin,sessionUser:admin,version:180006,databaseOid:"100",databaseOwner:admin},
    databases:[db(database,"100"),{...db("foundation","101"),acl:[...acl("10",["CONNECT","CREATE","TEMPORARY"]),grant("10","0","CONNECT"),grant("10","11","TEMPORARY")]},db("postgres","102")],
    roles:[role(admin,"10",{createDb:true,createRole:true,inherit:true}),role("legitimate","11")],memberships:[],schemas:[{oid:"2200",name:"public",owner:"pg_database_owner",acl:[grant("10","10","USAGE"),grant("10","10","CREATE"),grant("10","0","USAGE")]}],
    objects:[{catalog:"pg_class",oid:"200",name:"Event",kind:"r",identity:'public."Event"',owner:admin,parent:null,securityDefiner:false,schema:"public",extension:null,acl:acl("10",["SELECT","INSERT","UPDATE","DELETE"])},
      {catalog:"pg_proc",oid:"201",name:"trigger_guard",kind:"f",identity:'public.trigger_guard()',owner:admin,parent:null,securityDefiner:false,schema:"public",extension:null,acl:[...acl("10",["EXECUTE"]),grant("10","0","EXECUTE")]}],
    columns:[{tableOid:"200",table:"Event",number:1,name:"status",acl:[]}],extensions:[{oid:"500",name:"vector",owner:admin,version:"0.8.2",schemaOid:"2200"}],defaults:[]};
  const inventory=postgresRuntimeAccessIsolationInventory(catalog,"ops"); policy.isolation={inventorySha256:inventory.inventorySha256,databases:inventory.databases.map(d=>({name:d.name,oid:d.oid,owner:d.owner,
    action:d.name==="foundation"?"replace-public-connect":"verify-only",beforeAclSha256:d.aclSha256,preserveConnectRoles:d.name==="foundation"?[{name:"legitimate",oid:"11"}]:[]}))};
  const plan={schemaVersion:1,domain:"ops",intentSha256:"d".repeat(64),operationId:"phase-verified",serverResourceId:"/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture/providers/Microsoft.DBforPostgreSQL/flexibleServers/fixture",
    host,port,database,databaseOid:"100",administrator:admin,runtimeVaultUri:vault,policy};
  const records={},effects=[],settings={},guards=[],azureSettings={...AZURE_RUNTIME_ACCESS_SETTINGS},azureParameters={...AZURE_RUNTIME_ACCESS_SETTINGS};
  let saved,loseCommit=false,currentRole=admin,loggingModules="",historicalQueryRows=false;
  const foreignAllowed = new Set();
  const client={connection:{stream:{encrypted:true,authorized:true}},connectionParameters:{host,port,user:admin,ssl:{rejectUnauthorized:true}},async query(sql,args=[]) {
    const label=sql.match(/runtime-access:(\w+)/)?.[1];
    if(label) {
      if(label==="logging") return {rows:[{name:"shared_preload_libraries",setting:loggingModules},{name:"session_preload_libraries",setting:""},{name:"local_preload_libraries",setting:""}]};
      if(label==="azure") return {rows:Object.entries(azureSettings).map(([name,setting])=>({name,setting,pendingRestart:false}))};
      return {rows:structuredClone(label==="identity"?[catalog.identity]:catalog[label])};
    }
    if(sql.startsWith("BEGIN")) { saved=structuredClone(catalog); return {rows:[]}; }
    if(sql==="ROLLBACK") { catalog=saved;currentRole=admin;effects.push("ROLLBACK");return {rows:[]}; }
    if(sql==="COMMIT") {effects.push("COMMIT");saved=null;if(loseCommit)throw new Error("untrusted driver details");return {rows:[]};}
    if(sql.includes("set_config")){settings[args[0]]=args[1];return {rows:[]};}
    if(sql.startsWith("SELECT current_database() AS database,current_user AS administrator"))return {rows:[{
      database:catalog.identity.database,administrator:admin,sessionUser:admin,version:180006}]};
    if(sql.includes("current_setting"))return {rows:[{value:settings[args[0]]}]};
    if(sql.startsWith("SET LOCAL lock_timeout")||sql.startsWith("SET LOCAL statement_timeout"))return {rows:[]};
    if(sql==="SELECT current_database() AS database")return {rows:[{database}]};
    if(sql.includes("SELECT 1 FROM pg_catalog.pg_roles"))return {rows:catalog.roles.filter(r=>r.name===args[0])};
    if(sql.includes("AS schema_create"))return {rows:[{schema_create:false,broad_access:false,event_payload:false,job_payload:false}]};
    if(sql.startsWith("SELECT CASE WHEN"))return {rows:[{demand:0}]};
    if(sql.startsWith("SELECT datname AS name,oid::text AS oid"))return {rows:catalog.databases.filter(d=>d.name!==database)
      .map(d=>({name:d.name,oid:d.oid,allowed:foreignAllowed.has(d.name)
        || policy.isolation.databases.find(row=>row.name===d.name)?.action==="allow-provider-connect"}))};
    if(sql.startsWith("SET LOCAL ROLE")){currentRole=sql.match(/"([^"]+)"/)[1];return {rows:[]};}
    if(sql==="RESET ROLE"){currentRole=admin;return {rows:[]};}
    effects.push(sql.split(" ").slice(0,2).join(" "));
    if(sql.startsWith("CREATE ROLE")) {
      const name=sql.match(/CREATE ROLE "([^"]+)"/)[1],oid=name===runtime?"30":"31";
      catalog.roles.push(role(name,oid,{connectionLimit:name===runtime?-1:2}));catalog.roles.sort((a,b)=>a.name.localeCompare(b.name));
      catalog.memberships.push({roleOid:oid,memberOid:"10",grantorOid:"10",adminOption:true,inheritOption:false,setOption:false});
    } else if(sql.startsWith("GRANT") && sql.includes(" WITH SET TRUE")) {
      const name=sql.match(/GRANT "([^"]+)"/)[1];Object.assign(catalog.memberships.find(m=>m.roleOid===(name===runtime?"30":"31")),{setOption:true,inheritOption:name===runtime});
    } else if(sql.startsWith("GRANT") && sql.includes(" ON SCHEMA public")) {
      const oid=sql.endsWith(`"${runtime}"`)?"30":"31",privileges=sql.slice(6,sql.indexOf(" ON")).split(",");
      catalog.schemas[0].acl.push(...privileges.map(p=>grant("10",oid,p)));
    } else if(sql.startsWith("REVOKE") && sql.includes("ON DATABASE")) {
      const name=sql.match(/ON DATABASE "([^"]+)"/)[1],privs=sql.slice(7,sql.indexOf(" ON")).split(",");
      catalog.databases.find(d=>d.name===name).acl=catalog.databases.find(d=>d.name===name).acl.filter(a=>a.grantee!=="0"||!privs.includes(a.privilege));
    } else if(sql.startsWith("GRANT CONNECT")) {
      const [,name,who]=sql.match(/ON DATABASE "([^"]+)" TO "([^"]+)"/);const oid=catalog.roles.find(r=>r.name===who).oid;
      const list=catalog.databases.find(d=>d.name===name).acl;if(!list.some(a=>a.grantee===oid&&a.privilege==="CONNECT"))list.push(grant("10",oid,"CONNECT"));
    } else if(sql.startsWith("ALTER DEFAULT")) catalog.defaults=[{oid:"600",role:runtime,schemaOid:"0",kind:"f",acl:acl("30",["EXECUTE"])}];
    else if(sql.startsWith("ALTER ")) {
      const object=catalog.objects.find(o=>sql.includes(o.identity+" OWNER TO"));assert.ok(object);object.owner=runtime;
      object.acl=object.acl.map(a=>({...a,grantor:a.grantor==="10"?"30":a.grantor,grantee:a.grantee==="10"?"30":a.grantee}));
    } else if(sql.startsWith("REVOKE EXECUTE")) catalog.objects.find(o=>o.catalog==="pg_proc").acl=catalog.objects.find(o=>o.catalog==="pg_proc").acl.filter(a=>a.grantee!=="0");
    else if(sql.startsWith("GRANT SELECT") && sql.includes('public."Event"'))catalog.columns[0].acl=[grant("30","31","SELECT")];
    else if(!sql.startsWith("GRANT SELECT"))throw new Error("unexpected mutation");
    return {rows:[]};
  }};
  const options={plan,client,signal:new AbortController().signal,assertHeld:async()=>{guards.push("lease");},assertSourceFenced:async()=>{guards.push("source");},assertTargetInactive:async()=>{guards.push("target");},
    resolveSecretVersion:async version=>`postgresql://${version===policy.scaler.connectionSecretVersion?scaler:runtime}:${version===policy.scaler.connectionSecretVersion?scalerPassword:runtimePassword}@${host}:${port}/${database}?sslmode=verify-full`,
    readAzureParameters:async()=>Object.entries(azureParameters).map(([name,value])=>({name,value})),
    inspectAzureQueryStore:async()=>historicalQueryRows,
    persistIntent:async value=>{records.intent=structuredClone(value);},persistExpectedAfter:async value=>{records.expectedAfter=structuredClone(value);},readRecords:async()=>structuredClone(records),
    clientFactory:config=>({connection:{stream:{encrypted:true,authorized:true}},async connect(){assert.equal(config.password,config.user===runtime?runtimePassword:scalerPassword);},async end(){},async query(sql){
      if(sql.includes("rolsuper"))return {rows:[{database,role:scaler,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,memberships:false,rolconnlimit:2}]};
      if(sql.includes("AS schema_create"))return {rows:[{schema_create:false,broad_access:false,event_payload:false,job_payload:false}]};
      if(sql.startsWith("SELECT CASE"))return {rows:[{demand:0}]};
      if(sql.includes("datallowconn"))return {rows:policy.isolation.databases.map(d=>({name:d.name,oid:d.oid,allowed:d.action==="allow-provider-connect"}))};
      if(sql.includes("AS usage"))return {rows:[{usage:true,create:true}]};
      return {rows:[{role:config.user,database,oid:"100"}]};
    }})};
  return {options,records,effects,guards,azureSettings,azureParameters,foreignAllowed,
    set loggingModules(value){loggingModules=value;},set historicalQueryRows(value){historicalQueryRows=value;},
    get catalog(){return catalog;},set catalog(value){catalog=value;},loseCommit(){loseCommit=true;},passwords:[runtimePassword,scalerPassword]};
}

function azureFixture() {
  const f=fixture(),policy=f.options.plan.policy;
  policy.schemaVersion=2;policy.providerProfile="azure-flexible-postgres-18";
  f.loggingModules="pg_cron,pg_stat_statements,azure,pg_qs,pgaadauth,pgms_stats,pgms_wait_sampling,pg_availability";
  const provider=(name,oid,owner,ownerOid,isTemplate=false)=>({name,oid,owner,allowConnections:true,isTemplate,ownerAuthority:false,
    acl:[...acl(ownerOid,["CONNECT","CREATE","TEMPORARY"]),grant(ownerOid,"0","CONNECT"),grant(ownerOid,"0","TEMPORARY")]});
  f.catalog.databases.push(provider("azure_sys","103","azuresu","12"),provider("azure_maintenance","104","azuresu","12"),
    provider("template1","105","azure_pg_admin","13",true));
  f.catalog.databases.sort((a,b)=>a.name.localeCompare(b.name));
  const inventory=postgresRuntimeAccessIsolationInventory(f.catalog,"ops");
  policy.isolation={inventorySha256:inventory.inventorySha256,databases:inventory.databases.map(db=>({name:db.name,oid:db.oid,owner:db.owner,
    action:["azure_sys","azure_maintenance","template1"].includes(db.name)?"allow-provider-connect"
      :db.name==="foundation"?"replace-public-connect":"verify-only",beforeAclSha256:db.aclSha256,
    preserveConnectRoles:db.name==="foundation"?[{name:"legitimate",oid:"11"}]:[]}))};
  return f;
}

test("atomic role/object/ACL handoff preserves DB owner and authenticates exact versioned credentials",async()=>{
  const f=fixture(),intent=await preparePostgresRuntimeAccess(f.options);f.effects.length=0;
  const result=await applyPostgresRuntimeAccess({...f.options,intent});assert.equal(result.status,"APPLIED");assert.equal(result.isolation.complete,true);
  assert.equal(result.credentialAuthentication.complete,true);assert.equal(f.catalog.identity.databaseOwner,"fixture_admin");
  assert.equal(f.catalog.objects[1].owner,"corgtex_ops_runtime");assert.ok(!f.catalog.objects[1].acl.some(a=>a.grantee==="0"));
  assert.ok(f.catalog.databases[1].acl.some(a=>a.grantee==="11"&&a.privilege==="TEMPORARY"));
  assert.deepEqual(f.effects.filter(e=>["COMMIT","ROLLBACK"].includes(e)),["COMMIT"]);
  assert.ok(!JSON.stringify(f.records).includes("SCRAM-SHA-256"));for(const p of f.passwords)assert.ok(!JSON.stringify(f.records).includes(p));
  assert.equal(validatePostgresRuntimeAccessIntent(intent).sha256,intent.sha256);
});
test("lost COMMIT acknowledgement reconciles APPLIED using exact records without any replay",async()=>{
  const f=fixture(),intent=await preparePostgresRuntimeAccess(f.options);f.loseCommit();
  await assert.rejects(applyPostgresRuntimeAccess({...f.options,intent}),{code:"RUNTIME_ACCESS_RECONCILIATION_REQUIRED"});
  f.effects.length=0;const receipt=await reconcilePostgresRuntimeAccess({...f.options,intent});assert.equal(receipt.status,"APPLIED");assert.deepEqual(f.effects,[]);
  await assert.rejects(applyPostgresRuntimeAccess({...f.options,intent}),{code:"RUNTIME_ACCESS_RECONCILIATION_REQUIRED"});assert.deepEqual(f.effects,[]);
});
test("failed expected-after retention rolls back both roles and ownership; unchanged reconciliation never reapplies",async()=>{
  const f=fixture(),intent=await preparePostgresRuntimeAccess(f.options);
  await assert.rejects(applyPostgresRuntimeAccess({...f.options,intent,persistExpectedAfter:async()=>{throw new Error("store unavailable");}}));
  assert.equal(hash(f.catalog),intent.beforeSha256);f.effects.length=0;
  assert.equal((await reconcilePostgresRuntimeAccess({...f.options,intent})).status,"UNCHANGED");assert.deepEqual(f.effects,[]);
});
test("lost intent acknowledgement authorizes no SQL effects",async()=>{
  const f=fixture(),intent=await preparePostgresRuntimeAccess(f.options);f.effects.length=0;
  await assert.rejects(applyPostgresRuntimeAccess({...f.options,intent,persistIntent:async value=>{f.records.intent=value;throw new Error("lost ack");}}));assert.deepEqual(f.effects,[]);
  assert.equal((await reconcilePostgresRuntimeAccess({...f.options,intent})).status,"UNCHANGED");
});
test("missing after record or foreign drift is INDETERMINATE, never a success or replay",async()=>{
  for(const missing of [true,false]) {
    const f=fixture(),intent=await preparePostgresRuntimeAccess(f.options);await applyPostgresRuntimeAccess({...f.options,intent});
    if(missing)delete f.records.expectedAfter;else f.catalog.objects[0].owner="foreign";
    f.effects.length=0;assert.equal((await reconcilePostgresRuntimeAccess({...f.options,intent})).status,"INDETERMINATE");assert.deepEqual(f.effects,[]);
  }
});
test("changed before manifest/collision between prepare and apply rolls back before CREATE",async()=>{
  const f=fixture(),intent=await preparePostgresRuntimeAccess(f.options);f.catalog.roles.push(role("corgtex_ops_runtime","99"));f.effects.length=0;
  await assert.rejects(applyPostgresRuntimeAccess({...f.options,intent}),{code:"RUNTIME_ACCESS_BEFORE_CHANGED"});assert.deepEqual(f.effects,["ROLLBACK"]);
});
test("unknown object/security-definer/owner and changed inventory fail before role creation",async()=>{
  for(const kind of ["object","security","owner","inventory"]) {
    const f=fixture();if(kind==="object")f.catalog.objects[0].kind="f";if(kind==="security")f.catalog.objects[1].securityDefiner=true;
    if(kind==="owner")f.catalog.objects[0].owner="other";if(kind==="inventory")f.catalog.databases[1].oid="999";
    await assert.rejects(preparePostgresRuntimeAccess(f.options));assert.ok(!f.effects.some(e=>e.startsWith("CREATE")));
  }
});
test("vault/version/domain and DSN role/password binding fail closed without catalog mutation",async()=>{
  const f=fixture();const bad=structuredClone(f.options.plan.policy);bad.scaler.connectionSecretVersion=bad.scaler.connectionSecretVersion.replace("fixture-runtime","custody");
  assert.throws(()=>validatePostgresRuntimeAccessPolicy(bad,f.options.plan));
  await assert.rejects(preparePostgresRuntimeAccess({...f.options,resolveSecretVersion:async()=>"postgresql://admin:private@localhost/corgtex_ops?sslmode=verify-full"}));assert.deepEqual(f.effects,[]);
});
test("lease loss after expected-after retention rolls back all mutations",async()=>{
  const f=fixture(),intent=await preparePostgresRuntimeAccess(f.options);
  await assert.rejects(applyPostgresRuntimeAccess({...f.options,intent,assertHeld:async()=>{if(f.records.expectedAfter)return false;}}),{code:"RUNTIME_ACCESS_CUSTODY_LOST"});
  assert.equal(hash(f.catalog),intent.beforeSha256);assert.equal(f.effects.at(-1),"ROLLBACK");
});
test("provider-owned verify-only rows cannot become editable and effective foreign CONNECT blocks commit",async()=>{
  const f=fixture();f.options.plan.policy.isolation.databases.find(d=>d.name==="postgres").owner="provider";
  await assert.rejects(preparePostgresRuntimeAccess(f.options));
  const g=fixture(),intent=await preparePostgresRuntimeAccess(g.options),original=g.options.client.query;
  g.options.client.query=async(sql,args)=>sql.startsWith("SELECT datname AS name,oid::text AS oid")
    ?{rows:g.options.plan.policy.isolation.databases.map(d=>({name:d.name,oid:d.oid,allowed:d.name==="postgres"}))}:original(sql,args);
  await assert.rejects(applyPostgresRuntimeAccess({...g.options,intent}),{code:"RUNTIME_ACCESS_FOREIGN_CONNECT_ALLOWED"});assert.equal(hash(g.catalog),intent.beforeSha256);
});
test("preflight on postgres verifies exact inventory and logging capability without needing target OID",async()=>{
  const f=fixture();f.catalog.identity.database="postgres";f.catalog.identity.databaseOid="102";
  const {databaseOid,database,operationId,intentSha256,...plan}=f.options.plan;
  const result=await preparePostgresRuntimeAccessPreflight({...f.options,plan});assert.equal(result.complete,true);
  assert.deepEqual(f.effects,["ROLLBACK"]);
});


test("preflight rejects unavoidable PUBLIC CONNECT on verify-only provider DB before any role or scratch effect",async()=>{
  const f=fixture();f.catalog.identity.database="postgres";f.catalog.identity.databaseOid="102";
  f.catalog.databases.find(d=>d.name==="postgres").acl.push(grant("10","0","CONNECT"));
  const inventory=postgresRuntimeAccessIsolationInventory(f.catalog,"ops");f.options.plan.policy.isolation.inventorySha256=inventory.inventorySha256;
  f.options.plan.policy.isolation.databases.find(d=>d.name==="postgres").beforeAclSha256=inventory.databases.find(d=>d.name==="postgres").aclSha256;
  const {databaseOid,database,operationId,intentSha256,...plan}=f.options.plan;
  await assert.rejects(preparePostgresRuntimeAccessPreflight({...f.options,plan}),{code:"RUNTIME_ACCESS_PROVIDER_PUBLIC_CONNECT"});
  assert.deepEqual(f.effects,["ROLLBACK"]);
});


test("per-object effects check custody without repeated provider inventory; final external drift rolls back",async()=>{
  const f=fixture(),intent=await preparePostgresRuntimeAccess(f.options),calls=[];
  await assert.rejects(applyPostgresRuntimeAccess({...f.options,intent,assertTargetInactive:async({effect})=>{
    calls.push(effect);return effect!=="COMMIT";
  }}),{code:"RUNTIME_ACCESS_TARGET_NOT_INACTIVE"});
  assert.deepEqual(calls,["APPLY_ADMISSION","BEGIN","COMMIT"]);
  assert.equal(hash(f.catalog),intent.beforeSha256);assert.equal(f.effects.at(-1),"ROLLBACK");
});

test("exact Azure provider access survives commit and authenticated runtime readback",async()=>{
  const f=azureFixture();
  const intent=await preparePostgresRuntimeAccess(f.options);
  const result=await applyPostgresRuntimeAccess({...f.options,intent});
  assert.equal(result.status,"APPLIED");
  assert.ok(f.catalog.databases.find(db=>db.name==="azure_sys").acl.some(a=>a.grantee==="0"&&a.privilege==="CONNECT"));
  assert.equal((await reconcilePostgresRuntimeAccess({...f.options,intent})).status,"APPLIED");
});

test("Azure utility tracking exception requires explicit policy and disabled capture throughout",async()=>{
  const noOptIn=azureFixture();
  noOptIn.azureSettings["pg_qs.track_utility"]="on";
  noOptIn.azureParameters["pg_qs.track_utility"]="on";
  await assert.rejects(preparePostgresRuntimeAccess(noOptIn.options),
    {code:"RUNTIME_ACCESS_AZURE_LOGGING_UNSAFE"});
  const f=azureFixture();
  f.options.plan.policy.queryStoreUtilityTracking="capture-disabled-provider-on";
  f.azureSettings["pg_qs.track_utility"]="on";
  f.azureParameters["pg_qs.track_utility"]="on";
  f.azureSettings["pg_qs.interval_length_minutes"]="15";
  f.azureParameters["pg_qs.interval_length_minutes"]="15";
  const intent=await preparePostgresRuntimeAccess(f.options);
  assert.equal((await applyPostgresRuntimeAccess({...f.options,intent})).status,"APPLIED");
  assert.equal((await monitorPostgresRuntimeAccessDrift({...f.options,intent,
    expectedAfter:f.records.expectedAfter})).complete,true);
  for(const [name,value] of [["pg_qs.query_capture_mode","top"],
    ["pg_qs.store_query_plans","on"],["pgms_wait_sampling.query_capture_mode","all"]]) {
    f.azureParameters[name]=value;
    await assert.rejects(monitorPostgresRuntimeAccessDrift({...f.options,intent,
      expectedAfter:f.records.expectedAfter}),{code:"RUNTIME_ACCESS_AZURE_PARAMETER_MISMATCH"},name);
    f.azureParameters[name]=AZURE_RUNTIME_ACCESS_SETTINGS[name];
  }
  f.azureParameters["pg_qs.interval_length_minutes"]="30";
  await assert.rejects(monitorPostgresRuntimeAccessDrift({...f.options,intent,
    expectedAfter:f.records.expectedAfter}),{code:"RUNTIME_ACCESS_AZURE_PARAMETER_MISMATCH"});
  f.azureParameters["pg_qs.interval_length_minutes"]="15";
  f.historicalQueryRows=true;
  await assert.rejects(monitorPostgresRuntimeAccessDrift({...f.options,intent,
    expectedAfter:f.records.expectedAfter}),{code:"RUNTIME_ACCESS_AZURE_QUERY_HISTORY_PRESENT"});
});

test("Azure utility tracking exception rejects unknown opt-in and mismatched effective setting",async()=>{
  const f=azureFixture();
  f.options.plan.policy.queryStoreUtilityTracking="unreviewed";
  assert.throws(()=>validatePostgresRuntimeAccessPolicy(f.options.plan.policy,f.options.plan),
    {code:"RUNTIME_ACCESS_POLICY_INVALID"});
  f.options.plan.policy.queryStoreUtilityTracking="capture-disabled-provider-on";
  f.azureParameters["pg_qs.track_utility"]="on";
  f.azureSettings["pg_qs.interval_length_minutes"]="15";
  f.azureParameters["pg_qs.interval_length_minutes"]="15";
  await assert.rejects(preparePostgresRuntimeAccess(f.options),
    {code:"RUNTIME_ACCESS_AZURE_LOGGING_UNSAFE"});
});

test("Azure exception rejects unreviewed databases, changed identity, and unsafe capture before any mutation",async()=>{
  for(const drift of ["unknown","owner","template","oid","acl","capture","parameter","hook","history"]) {
    const f=azureFixture(),db=f.catalog.databases.find(row=>row.name==="azure_sys");
    if(drift==="unknown") f.options.plan.policy.isolation.databases.find(row=>row.name==="foundation").action="allow-provider-connect";
    if(drift==="owner") db.owner="other";
    if(drift==="template") db.isTemplate=true;
    if(drift==="oid") db.oid="999";
    if(drift==="acl") db.acl.push(grant("12","99","CONNECT"));
    if(drift==="capture") f.azureSettings["pg_qs.query_capture_mode"]="all";
    if(drift==="parameter") f.azureParameters["pg_qs.query_capture_mode"]="top";
    if(drift==="hook") f.loggingModules="pg_stat_statements,pgaudit";
    if(drift==="history") f.historicalQueryRows=true;
    await assert.rejects(preparePostgresRuntimeAccess(f.options),{name:"PostgresRuntimeAccessError"},drift);
    assert.ok(!f.effects.some(effect=>effect.startsWith("CREATE")||effect.startsWith("ALTER")),drift);
  }
});

test("Azure capture drift before commit rolls back credentials and ownership",async()=>{
  const f=azureFixture(),intent=await preparePostgresRuntimeAccess(f.options);
  const original=f.options.persistExpectedAfter;
  await assert.rejects(applyPostgresRuntimeAccess({...f.options,intent,persistExpectedAfter:async value=>{
    await original(value);f.azureParameters["pg_qs.track_utility"]="on";
  }}),{code:"RUNTIME_ACCESS_AZURE_PARAMETER_MISMATCH"});
  assert.equal(hash(f.catalog),intent.beforeSha256);
  assert.equal(f.effects.at(-1),"ROLLBACK");
});

test("active Azure drift check tolerates application migrations but rejects provider ACL and capture changes",async()=>{
  const f=azureFixture(),intent=await preparePostgresRuntimeAccess(f.options);
  await applyPostgresRuntimeAccess({...f.options,intent});
  f.catalog.objects.push({...f.catalog.objects[0],oid:"999",name:"new_table",identity:"public.new_table"});
  assert.equal((await monitorPostgresRuntimeAccessDrift({...f.options,intent,expectedAfter:f.records.expectedAfter})).complete,true);
  f.catalog.databases.push({name:"corgtex_core",oid:"106",owner:"fixture_admin",allowConnections:true,isTemplate:false,
    ownerAuthority:true,acl:acl("10",["CONNECT"])});
  assert.equal((await monitorPostgresRuntimeAccessDrift({...f.options,intent,expectedAfter:f.records.expectedAfter})).complete,true);
  f.foreignAllowed.add("corgtex_core");
  await assert.rejects(monitorPostgresRuntimeAccessDrift({...f.options,intent,expectedAfter:f.records.expectedAfter}),
    {code:"RUNTIME_ACCESS_FOREIGN_CONNECT_ALLOWED"});
  f.foreignAllowed.delete("corgtex_core");
  f.catalog.databases.find(db=>db.name==="azure_sys").acl.push(grant("12","99","CONNECT"));
  await assert.rejects(monitorPostgresRuntimeAccessDrift({...f.options,intent,expectedAfter:f.records.expectedAfter}),
    {code:"RUNTIME_ACCESS_DATABASE_DRIFT"});
  f.catalog.databases.find(db=>db.name==="azure_sys").acl.pop();
  f.azureParameters["pg_qs.query_capture_mode"]="all";
  await assert.rejects(monitorPostgresRuntimeAccessDrift({...f.options,intent,expectedAfter:f.records.expectedAfter}),
    {code:"RUNTIME_ACCESS_AZURE_PARAMETER_MISMATCH"});
});
