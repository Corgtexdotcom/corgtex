import { afterEach, describe, expect, it, vi } from "vitest";

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

const approveQualification = vi.fn();
const completeActivity = vi.fn();
const convertCrmAccountToClient = vi.fn();
const createActivity = vi.fn();
const createCommunicationSuggestion = vi.fn();
const createContact = vi.fn();
const createCrmAccount = vi.fn();
const createDeal = vi.fn();
const createExecutionRequest = vi.fn();
const createConversationMessage = vi.fn();
const createPracticeProjectFromWonDeal = vi.fn();
const declineCommunicationSuggestion = vi.fn();
const deleteContact = vi.fn();
const deleteDeal = vi.fn();
const enforceDemoGuard = vi.fn();
const failCommunicationSuggestion = vi.fn();
const markCommunicationSuggestionSent = vi.fn();
const provisionProspectWorkspace = vi.fn();
const rejectQualification = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const requireWorkspaceFeature = vi.fn();
const sendSchedulingLinkEmail = vi.fn();
const updateCommunicationSuggestion = vi.fn();
const updateContact = vi.fn();
const updateCrmAccount = vi.fn();
const updateDeal = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@/lib/workspace-feature-flags", () => ({
  requireWorkspaceFeature,
}));

vi.mock("@corgtex/domain", () => ({
  approveQualification,
  completeActivity,
  convertCrmAccountToClient,
  createActivity,
  createCommunicationSuggestion,
  createContact,
  createConversationMessage,
  createCrmAccount,
  createDeal,
  createExecutionRequest,
  createPracticeProjectFromWonDeal,
  declineCommunicationSuggestion,
  deleteContact,
  deleteDeal,
  failCommunicationSuggestion,
  markCommunicationSuggestionSent,
  provisionProspectWorkspace,
  rejectQualification,
  sendSchedulingLinkEmail,
  updateCommunicationSuggestion,
  updateContact,
  updateCrmAccount,
  updateDeal,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function buildDealFormData(stage?: string) {
  const formData = new FormData();
  formData.set("workspaceId", "workspace-1");
  formData.set("contactId", "contact-1");
  formData.set("title", "New pilot");
  formData.set("value", "12000");
  if (stage) formData.set("stage", stage);
  return formData;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("relationship server actions", () => {
  it("passes allowed active stage defaults when creating a deal", async () => {
    const { createDealAction } = await import("./actions");

    await createDealAction(buildDealFormData("QUALIFIED"));

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(createDeal).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      title: "New pilot",
      valueCents: 1200000,
      stage: "QUALIFIED",
    }));
  });

  it("does not pass invalid or terminal stage defaults when creating a deal", async () => {
    const { createDealAction } = await import("./actions");

    await createDealAction(buildDealFormData("CLOSED_WON"));

    expect(createDeal.mock.calls[0]?.[1]?.stage).toBeUndefined();

    vi.clearAllMocks();
    await createDealAction(buildDealFormData("NOT_A_STAGE"));

    expect(createDeal.mock.calls[0]?.[1]?.stage).toBeUndefined();
  });
});
