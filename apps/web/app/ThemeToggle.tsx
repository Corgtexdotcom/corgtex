"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();

  // useEffect only runs on the client, so now we can safely show the UI
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="w-8 h-8 opacity-0"></div>;
  }

  const cycleTheme = () => {
    if (theme === "system") setTheme("light");
    else if (theme === "light") setTheme("dark");
    else setTheme("system");
  };

  const getIcon = () => {
    if (theme === "system") return "💻";
    if (theme === "light") return "☀️";
    return "🌙";
  };

  return (
    <button
      onClick={cycleTheme}
      className="ws-nav-link"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        width: "100%",
        background: "transparent",
        color: "var(--text)",
        border: "none",
        cursor: "pointer",
        padding: "8px 12px",
        borderRadius: "var(--radius-md)",
        fontSize: "0.92rem",
        fontWeight: 500,
        gap: "12px",
        marginTop: "4px"
      }}
      title={`Theme: ${theme}`}
    >
      <span className="ws-nav-icon">{getIcon()}</span>
      <span>{theme ? theme.charAt(0).toUpperCase() + theme.slice(1) : ""} Theme</span>
    </button>
  );
}
