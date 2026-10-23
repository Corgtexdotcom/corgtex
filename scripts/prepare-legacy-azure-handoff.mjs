#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { prepareAzureHandoff } from "../deploy/legacy-handoff/azure-utility.mjs";

// Offline artifact creation only. No Azure CLI, auth, network or deployment calls.
const [inputPath, outputPath] = process.argv.slice(2);
try {
  if (!inputPath || !outputPath || process.argv.length !== 4) throw new Error("HANDOFF_INPUT_AND_OUTPUT_REQUIRED");
  const evidence = JSON.parse(await readFile(inputPath, "utf8"));
  const { candidate, summary } = prepareAzureHandoff(evidence);
  const container = candidate.containers[0];
  // Never persist or print the full template: it may contain private env values.
  await writeFile(outputPath, JSON.stringify({ summary, containerCommandDelta: {
    name: container.name, command: container.command, args: container.args,
  } }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error?.message?.startsWith("HANDOFF_") ? error.message : "HANDOFF_PREPARATION_FAILED");
  process.exitCode = 1;
}
