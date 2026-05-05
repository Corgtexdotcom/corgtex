export type LoginActionState = {
  email: string;
  error: string | null;
  redirectTo: string | null;
};

export const initialLoginActionState: LoginActionState = {
  email: "",
  error: null,
  redirectTo: null,
};
