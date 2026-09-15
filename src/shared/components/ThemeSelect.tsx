import {
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ChevronDown } from "lucide-react";

export interface ThemeSelectOption<T extends string | number> {
  value: T;
  label: string;
}

interface ThemeSelectProps<T extends string | number> {
  id: string;
  value: T;
  options: ReadonlyArray<ThemeSelectOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

export function getNextOptionIndex(currentIndex: number, optionCount: number, key: string) {
  if (optionCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return optionCount - 1;
  if (key !== "ArrowDown" && key !== "ArrowUp") return currentIndex;
  const direction = key === "ArrowDown" ? 1 : -1;
  return (currentIndex + direction + optionCount) % optionCount;
}

export default function ThemeSelect<T extends string | number>({
  id,
  value,
  options,
  onChange,
  className,
  disabled = false,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: ThemeSelectProps<T>) {
  const generatedId = useId();
  const listboxId = `${id || generatedId}-options`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setHighlightedIndex(selectedIndex);
    }
  }, [open, selectedIndex]);

  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const chooseOption = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeAndFocus();
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        closeAndFocus();
      }
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) {
        chooseOption(highlightedIndex);
      } else {
        setHighlightedIndex(selectedIndex);
        setOpen(true);
      }
      return;
    }
    const nextIndex = getNextOptionIndex(highlightedIndex, options.length, event.key);
    if (nextIndex !== highlightedIndex) {
      event.preventDefault();
      if (open) {
        setHighlightedIndex(nextIndex);
      } else {
        setHighlightedIndex(nextIndex);
        setOpen(true);
      }
    }
  };

  const selectedLabel = selectedOption?.label ?? "请选择";
  return (
    <div ref={rootRef} className={`theme-select${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="theme-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-option-${highlightedIndex}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        disabled={disabled}
        onClick={() => {
          setHighlightedIndex(selectedIndex);
          setOpen((current) => !current);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="theme-select-value">{selectedLabel}</span>
        <ChevronDown className={`theme-select-chevron${open ? " theme-select-chevron-open" : ""}`} size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div id={listboxId} className="theme-select-list" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              key={String(option.value)}
              type="button"
              id={`${listboxId}-option-${index}`}
              className={`theme-select-option${index === selectedIndex ? " theme-select-option-selected" : ""}${index === highlightedIndex ? " theme-select-option-highlighted" : ""}`}
              role="option"
              aria-selected={index === selectedIndex}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => chooseOption(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
