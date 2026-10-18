import {
  captureSqlIngestionAttempt, claimSqlIngestionAttempt, disposeSqlIngestionCapture,
  failSqlIngestionAttempt, renewSqlIngestionAttempt,
} from "@corgtex/domain";
import { prepareSqlKnowledgeAttempt, publishPreparedSqlKnowledgeAttempt } from "@corgtex/knowledge";
import { createSqlIngestionRunner } from "./runner";

export const syncExternalDataSource = createSqlIngestionRunner({
  claimSqlIngestionAttempt,
  renewSqlIngestionAttempt,
  captureSqlIngestionAttempt,
  failSqlIngestionAttempt,
  disposeSqlIngestionCapture,
  prepareSqlKnowledgeAttempt,
  publishPreparedSqlKnowledgeAttempt,
});
