export function FormMessage({ type, message }: { type: "error" | "success"; message: string }) {
  if (!message) return null;
  return (
    <div className={`form-message form-message-${type}`} role="alert">
      {message}
    </div>
  );
}
