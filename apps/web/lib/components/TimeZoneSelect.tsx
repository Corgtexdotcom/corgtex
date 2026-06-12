"use client";

import { useEffect, useMemo, useState } from "react";

const FALLBACK_TIME_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Amsterdam",
  "Europe/Berlin",
  "Europe/Prague",
  "Europe/Madrid",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

function supportedTimeZones() {
  const supportedValuesOf = (Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  }).supportedValuesOf;
  try {
    return supportedValuesOf ? supportedValuesOf("timeZone") : FALLBACK_TIME_ZONES;
  } catch {
    return FALLBACK_TIME_ZONES;
  }
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function TimeZoneSelect({
  name = "timeZone",
  label = "Time zone",
  value,
  onValueChange,
}: {
  name?: string;
  label?: string;
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const options = useMemo(() => supportedTimeZones(), []);
  const [internalValue, setInternalValue] = useState(value ?? "UTC");
  const selected = value ?? internalValue;

  useEffect(() => {
    if (value) return;
    const next = browserTimeZone();
    setInternalValue(next);
    onValueChange?.(next);
  }, [onValueChange, value]);

  const mergedOptions = options.includes(selected) ? options : [selected, ...options];

  return (
    <label>
      {label}
      <select
        name={name}
        value={selected}
        onChange={(event) => {
          const next = event.target.value;
          setInternalValue(next);
          onValueChange?.(next);
        }}
      >
        {mergedOptions.map((timeZone) => (
          <option key={timeZone} value={timeZone}>{timeZone}</option>
        ))}
      </select>
    </label>
  );
}
