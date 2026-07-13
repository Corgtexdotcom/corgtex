export type SignupErrorKey =
  | "companyRequired"
  | "emailRequired"
  | "termsRequired"
  | "rateLimited"
  | "unavailable";

type SignupStatus = "idle" | "active" | "review" | "existingAccount";

export type SignupState = {
  adminEmail: string;
  adminName: string;
  companyName: string;
  errorKey: SignupErrorKey | null;
  idempotencyKey: string;
  status: SignupStatus;
};

export function initialSignupState(idempotencyKey: string): SignupState {
  return {
    adminEmail: "",
    adminName: "",
    companyName: "",
    errorKey: null,
    idempotencyKey,
    status: "idle",
  };
}
