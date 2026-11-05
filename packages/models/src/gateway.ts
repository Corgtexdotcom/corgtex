import { env } from "@corgtex/shared";
import type { ModelGateway } from "./contracts";
import { fakeModelGateway } from "./fake-gateway";
import { openAICompatibleModelGateway } from "./openai-compatible-gateway";

function createDefaultModelGateway(): ModelGateway {
  if (env.MODEL_PROVIDER === "fake") {
    return fakeModelGateway;
  }

  return openAICompatibleModelGateway;
}

export const defaultModelGateway = createDefaultModelGateway();
