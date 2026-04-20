export type LoginActionState = {
  email: string;
  error: string | null;
};

export const initialLoginActionState: LoginActionState = {
  email: "",
  error: null,
};
