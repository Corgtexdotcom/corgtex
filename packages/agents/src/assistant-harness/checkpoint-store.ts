import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { ChannelVersions, Checkpoint, CheckpointMetadata, CheckpointTuple, PendingWrite } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AssistantHarnessError } from "./contracts";
import type { AssistantScope } from "./contracts";

/** Integration contract, deliberately without a PostgreSQL implementation until the domain
 * receipt/claim transaction is agreed. Each method must authorize this binding. put/putWrites
 * must compare the current job owner+attempt and checkpoint lineage INSIDE their write transaction.
 * A preflight check followed by stock PostgresSaver.put on another connection is NOT sufficient.
 * Preserve the official saver format/serializer in the eventual transaction adapter. */
export interface ClaimedCheckpointPort {
  getTuple(scope: AssistantScope, config: RunnableConfig): Promise<CheckpointTuple | undefined>;
  put(scope: AssistantScope, config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, versions: ChannelVersions): Promise<RunnableConfig>;
  putWrites(scope: AssistantScope, config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void>;
}

/** Narrows a claim-bound app port to the SDK API; this wrapper does not itself prove fencing. */
export class AssistantCheckpointStore extends BaseCheckpointSaver {
  constructor(private readonly scope: AssistantScope, private readonly port: ClaimedCheckpointPort, private readonly maxBytes = 1_048_576) {
    super();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 4_194_304) throw new AssistantHarnessError("LIMIT");
  }

  private check(config: RunnableConfig, value?: unknown) {
    if (config.configurable?.thread_id !== this.scope.runId || (config.configurable?.checkpoint_ns ?? "") !== "") {
      throw new AssistantHarnessError("SCOPE");
    }
    if (value !== undefined && Buffer.byteLength(JSON.stringify(value), "utf8") > this.maxBytes) throw new AssistantHarnessError("LIMIT");
  }

  async getTuple(config: RunnableConfig) {
    this.check(config);
    const tuple = await this.port.getTuple(this.scope, config);
    if (tuple) {
      this.check(tuple.config, tuple);
      if (tuple.parentConfig) this.check(tuple.parentConfig);
    }
    return tuple;
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, versions: ChannelVersions) {
    this.check(config, { checkpoint, metadata, versions });
    const next = await this.port.put(this.scope, config, checkpoint, metadata, versions);
    this.check(next);
    return next;
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string) {
    this.check(config, writes);
    await this.port.putWrites(this.scope, config, writes, taskId);
  }

  // History/export/deletion require a separately authorized domain lifecycle path.
  async *list(): AsyncGenerator<CheckpointTuple> { throw new AssistantHarnessError("CHECKPOINT"); }
  async deleteThread(): Promise<void> { throw new AssistantHarnessError("CHECKPOINT"); }
}
