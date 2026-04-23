export type ForgotPasswordState = {
  email: string;
  error: string | null;
  success: boolean;
};

export const initialForgotPasswordState: ForgotPasswordState = {
  email: "",
  error: null,
  success: false,
};
