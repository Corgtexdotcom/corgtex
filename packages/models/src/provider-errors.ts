export class ModelProviderHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ModelProviderHttpError";
  }
}
