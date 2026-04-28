"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({ 
  children, 
  variant = "primary",
  className = ""
}: { 
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
}) {
  const { pending } = useFormStatus();
  
  const baseClass = variant === "primary" ? "btn" : `btn-${variant}`;
  
  return (
    <button 
      type="submit" 
      className={`${baseClass} ${className}`} 
      disabled={pending}
    >
      {pending ? "..." : children}
    </button>
  );
}
