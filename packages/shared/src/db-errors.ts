const DATABASE_UNAVAILABLE_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
]);

const DATABASE_SCHEMA_MISSING_CODES = new Set([
  "P2021",
  "P2022",
]);

const DATABASE_UNAVAILABLE_MESSAGES = [
  "can't reach database server",
  "connection pool timeout",
  "timed out fetching a new connection",
  "server closed the connection unexpectedly",
  "connection terminated unexpectedly",
  "failed to connect to server",
  "database is unavailable",
  "database unavailable",
  "database down",
  "econnrefused",
];

const DATABASE_SCHEMA_MISSING_MESSAGES = [
  "does not exist in the current database",
  "relation does not exist",
  "column does not exist",
  "enum does not exist",
];

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
};

function errorLike(value: unknown): ErrorLike | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as ErrorLike;
}

function errorName(error: ErrorLike | null) {
  return typeof error?.name === "string" ? error.name : "";
}

function errorCode(error: ErrorLike | null) {
  return typeof error?.code === "string" ? error.code : "";
}

function errorMessage(error: ErrorLike | null) {
  return typeof error?.message === "string" ? error.message.toLowerCase() : "";
}

export function isDatabaseUnavailableError(error: unknown) {
  const candidate = errorLike(error);
  const name = errorName(candidate);
  const code = errorCode(candidate);
  const message = errorMessage(candidate);

  if (name === "PrismaClientInitializationError" || name === "PrismaClientRustPanicError") {
    return true;
  }

  if (name === "PrismaClientKnownRequestError" && DATABASE_UNAVAILABLE_CODES.has(code)) {
    return true;
  }

  return DATABASE_UNAVAILABLE_MESSAGES.some((pattern) => message.includes(pattern));
}

export function isDatabaseSchemaMissingError(error: unknown) {
  const candidate = errorLike(error);
  const name = errorName(candidate);
  const code = errorCode(candidate);
  const message = errorMessage(candidate);

  if (name === "PrismaClientKnownRequestError" && DATABASE_SCHEMA_MISSING_CODES.has(code)) {
    return true;
  }

  if (/(relation|column|enum)\s+".*"\s+does not exist/i.test(message)) {
    return true;
  }

  return DATABASE_SCHEMA_MISSING_MESSAGES.some((pattern) => message.includes(pattern));
}
