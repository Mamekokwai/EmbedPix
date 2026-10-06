import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 240 });
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !listRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || disabled) return;
    const placeList = () => {
      const trigger = triggerRef.current;
      if (!trigger || !trigger.getClientRects().length) { setOpen(false); return; }
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 13;
      const above = rect.top - 13;
      const upward = below < 240 && above > below;
      const maxHeight = Math.max(0, Math.min(240, upward ? above : below));
      const height = Math.min(listRef.current?.scrollHeight ?? maxHeight, maxHeight);
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)), top: upward ? rect.top - height - 5 : rect.bottom + 5, width: Math.min(rect.width, window.innerWidth - 16), maxHeight });
    };
    placeList();
    const onScroll = (event: Event) => {
      if (!listRef.current?.contains(event.target as Node)) placeList();
    };
    window.addEventListener("resize", placeList);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", placeList);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, disabled, options.length]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const option = list?.children[highlightedIndex] as HTMLElement | undefined;
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [open, highlightedIndex, position.maxHeight]);

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
    if (triggerRef.current?.matches(":disabled")) { setOpen(false); return; }
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
    if (options.length === 0) return;
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
        aria-activedescendant={open && options.length ? `${listboxId}-option-${highlightedIndex}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        disabled={disabled || options.length === 0}
        title={selectedLabel}
        onBlur={() => setOpen(false)}
        onClick={() => {
          setHighlightedIndex(selectedIndex);
          setOpen((current) => !current);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="theme-select-value">{selectedLabel}</span>
        <ChevronDown className={`theme-select-chevron${open ? " theme-select-chevron-open" : ""}`} size={15} aria-hidden="true" />
      </button>
      {open && !disabled ? createPortal(
        <div ref={listRef} id={listboxId} className="theme-select-list" style={position} role="listbox" aria-label={ariaLabel} onMouseDown={(event) => event.preventDefault()}>
          {options.map((option, index) => (
            <button
              key={String(option.value)}
              type="button"
              id={`${listboxId}-option-${index}`}
              className={`theme-select-option${index === selectedIndex ? " theme-select-option-selected" : ""}${index === highlightedIndex ? " theme-select-option-highlighted" : ""}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === selectedIndex}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => chooseOption(index)}
            >
              {option.label}
            </button>
          ))}
        </div>, document.body
      ) : null}
    </div>
  );
}
