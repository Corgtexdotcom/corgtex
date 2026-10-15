import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createConversation, listConversations } from "./conversations";
import { listExecutionRequests } from "./execution-plumbing";
import { recordArtifactInputLineage } from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({data:{name:"Synthetic recent readers",slug:randomUUID()}});
  const user = await prisma.user.create({data:{email:`${randomUUID()}@example.test`,passwordHash:"synthetic"}});
  const member = await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"CONTRIBUTOR"}});
  const actor: AppActor = {kind:"user",user};
  const revokeRestore = async () => {
    await prisma.member.update({where:{id:member.id},data:{isActive:false}});
    await prisma.member.update({where:{id:member.id},data:{isActive:true}});
  };
  return {workspaceId:workspace.id,user,actor,revokeRestore};
}

it("retains the counted session's original epoch across a later turn query and revoke/restore",async()=>{
  const f=await fixture();
  const session=await createConversation(f.actor,{workspaceId:f.workspaceId,topic:"Original private conversation"});
  // This query occurs only after the session was admitted to the total/page.
  const query=prisma.conversationTurn.findMany.bind(prisma.conversationTurn);
  let changed=false;
  const barrier=vi.spyOn(prisma.conversationTurn,"findMany").mockImplementation(async args=>{
    if(!changed && args?.where?.conversationId===session.id){changed=true;await f.revokeRestore();}
    return query(args);
  });
  await expect(listConversations(f.actor,f.workspaceId,{take:1})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(barrier).toHaveBeenCalledTimes(1);
});

it("retains a selected request's original epoch across its result query and revoke/restore",async()=>{
  const f=await fixture();
  const request=await prisma.executionRequest.create({data:{workspaceId:f.workspaceId,createdByUserId:f.user.id,goal:"Synthetic original request"}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,
    artifact:{kind:"ExecutionRequest",id:request.id},content:request,origin:"HUMAN_ORIGINAL",inputs:[]}));
  const query=prisma.executionResult.findMany.bind(prisma.executionResult);
  let changed=false;
  const barrier=vi.spyOn(prisma.executionResult,"findMany").mockImplementation(async args=>{
    if(!changed && args?.where?.executionRequestId===request.id){changed=true;await f.revokeRestore();}
    return query(args);
  });
  await expect(listExecutionRequests(f.actor,{workspaceId:f.workspaceId,take:1})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(barrier).toHaveBeenCalledTimes(1);
});

it("retains a counted session's original manifest head when the body is unchanged",async()=>{
  const f=await fixture();
  const session=await createConversation(f.actor,{workspaceId:f.workspaceId,topic:"Unchanged body"});
  const query=prisma.conversationTurn.findMany.bind(prisma.conversationTurn);
  let changed=false;
  vi.spyOn(prisma.conversationTurn,"findMany").mockImplementation(async args=>{
    if(!changed){
      changed=true;
      const head=await prisma.artifactInputLineage.findFirstOrThrow({where:{workspaceId:f.workspaceId,artifactType:"ConversationSession",artifactId:session.id},orderBy:{revision:"desc"}});
      const {id: _id,createdAt: _createdAt,...data}=head;
      await prisma.artifactInputLineage.create({data:{...data,revision:head.revision+1,inputsJson:[],rootsJson:[]}});
    }
    return query(args);
  });
  await expect(listConversations(f.actor,f.workspaceId,{take:1})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});
