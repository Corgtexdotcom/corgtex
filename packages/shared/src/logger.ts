// TODO: replace with logger from Backend Hardening PR
export const logger = {
  info: (msg: string, meta?: any) => console.log(JSON.stringify({ level: "info", msg, ...meta })),
  warn: (msg: string, meta?: any) => console.warn(JSON.stringify({ level: "warn", msg, ...meta })),
  error: (msg: string, meta?: any) => console.error(JSON.stringify({ level: "error", msg, ...meta })),
};
