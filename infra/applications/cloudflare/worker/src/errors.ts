export class HttpServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpServiceError";
    this.status = status;
  }
}

export const badRequest = (message: string): never => {
  throw new HttpServiceError(400, message);
};

export const failedPrecondition = (message: string): never => {
  throw new HttpServiceError(412, message);
};
