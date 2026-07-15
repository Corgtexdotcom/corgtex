"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const EMPTY_SELECTED_VALUES: readonly string[] = [];

export type MultiSelectFilterOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export function MultiSelectFilter({
  name,
  label,
  options,
  selectedValues,
  allLabel,
  selectAllLabel = "Select all",
  unselectAllLabel = "Unselect all",
  selectedCountLabel = "{count} selected",
  collapseAllToEmpty = true,
  className,
  triggerClassName,
  panelClassName,
  onSelectionChange,
}: {
  name: string;
  label?: string;
  options: MultiSelectFilterOption[];
  selectedValues?: readonly string[];
  allLabel: string;
  selectAllLabel?: string;
  unselectAllLabel?: string;
  selectedCountLabel?: string;
  collapseAllToEmpty?: boolean;
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
  onSelectionChange?: (values: string[]) => void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const isControlled = selectedValues !== undefined;
  const [open, setOpen] = useState(false);
  const [currentValues, setCurrentValues] = useState<string[]>(() => normalizeValues(
    selectedValues ?? EMPTY_SELECTED_VALUES,
    options,
    collapseAllToEmpty,
  ));
  const optionByValue = useMemo(() => new Map(options.map((option) => [option.value, option])), [options]);

  useEffect(() => {
    if (isControlled) {
      setCurrentValues(normalizeValues(selectedValues ?? EMPTY_SELECTED_VALUES, options, collapseAllToEmpty));
      return;
    }

    setCurrentValues((values) => normalizeValues(values, options, collapseAllToEmpty));
  }, [collapseAllToEmpty, isControlled, options, selectedValues]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selectedSet = new Set(currentValues);
  const triggerText = currentValues.length === 0
    ? allLabel
    : currentValues.length === 1
      ? optionByValue.get(currentValues[0])?.label ?? currentValues[0]
      : selectedCountLabel.replace("{count}", String(currentValues.length));

  const updateValues = (values: string[]) => {
    const normalized = normalizeValues(values, options, collapseAllToEmpty);
    setCurrentValues(normalized);
    onSelectionChange?.(normalized);
  };

  const toggleValue = (value: string) => {
    updateValues(selectedSet.has(value)
      ? currentValues.filter((entry) => entry !== value)
      : [...currentValues, value]);
  };

  const handleBulkAction = () => {
    updateValues(currentValues.length > 0 ? [] : options.filter((option) => !option.disabled).map((option) => option.value));
  };

  return (
    <div ref={rootRef} className={cn("nr-multi-select", className)}>
      {currentValues.map((value) => (
        <input key={value} type="hidden" name={name} value={value} />
      ))}
      {label && <span className="nr-item-meta">{label}</span>}
      <button
        type="button"
        id={`${id}-trigger`}
        className={cn("nr-multi-select-trigger", triggerClassName)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{triggerText}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={`${id}-panel`}
          className={cn("nr-multi-select-panel", panelClassName)}
          aria-labelledby={`${id}-trigger`}
        >
          <button type="button" className="nr-multi-select-option nr-multi-select-bulk" onClick={handleBulkAction}>
            <span className="nr-multi-select-check" aria-hidden="true">
              {currentValues.length > 0 ? <Check size={14} /> : null}
            </span>
            <span>{currentValues.length > 0 ? unselectAllLabel : selectAllLabel}</span>
          </button>
          <div className="nr-multi-select-options">
            {options.map((option) => (
              <label key={option.value} className={cn("nr-multi-select-option", option.disabled && "nr-multi-select-option-disabled")}>
                <input
                  type="checkbox"
                  value={option.value}
                  checked={selectedSet.has(option.value)}
                  disabled={option.disabled}
                  onChange={() => toggleValue(option.value)}
                />
                <span className="nr-multi-select-check" aria-hidden="true">
                  {selectedSet.has(option.value) ? <Check size={14} /> : null}
                </span>
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function normalizeValues(values: readonly string[], options: MultiSelectFilterOption[], collapseAllToEmpty: boolean) {
  const allowedValues = new Set(options.filter((option) => !option.disabled).map((option) => option.value));
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (!allowedValues.has(value) || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return collapseAllToEmpty && normalized.length === allowedValues.size ? [] : normalized;
}
