import { CaretUpDownIcon, CheckIcon, StackIcon } from "@phosphor-icons/react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  moveActive,
  switcherLabel,
  switcherOptions,
  typeAhead,
  typeAheadCharacter,
} from "./switcher-model.ts";
import { workspaceHue } from "./timeline-model.ts";
import { iconProps } from "./ui-icons.tsx";

const ANCHOR_MIN_VIEWPORT = 560;

function initial(name: string) {
  return (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase();
}

export function WorkspaceAvatar({ id, name }: { id: string; name: string }) {
  return (
    <span className="k-avatar" data-ws={workspaceHue(id)} aria-hidden="true">
      {initial(name)}
    </span>
  );
}

/**
 * Compact project switcher (design spec §4 `.k-switcher`): a button and a listbox popover.
 * Escape and selection return focus to the trigger; Tab out or an outside click closes it.
 */
export function WorkspaceSwitcher({
  workspaces,
  selected,
  fallbackName,
  includeAll = true,
  onSelect,
}: {
  workspaces: readonly { id: string; name: string }[];
  selected: string | null;
  /** Name of a filtered workspace that is no longer mounted. */
  fallbackName?: string;
  /** False in the host viewer, which shows one project at a time. */
  includeAll?: boolean;
  onSelect(id: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  // A press on the trigger blurs the open listbox first; remember what the press meant.
  const pressIntent = useRef<"open" | "close" | undefined>(undefined);
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const options = switcherOptions(workspaces, includeAll);
  // A missing selection falls back to 全部專案 when it is offered; otherwise nothing is checked.
  const found = options.findIndex((option) => option.id === selected);
  const selectedIndex = found >= 0 ? found : includeAll ? 0 : -1;
  const label = switcherLabel(selected, workspaces, fallbackName, includeAll);
  // An avatar only for a project that is still named; otherwise the 全部專案 stack icon.
  const selectedWorkspace =
    selected && (fallbackName || workspaces.some((item) => item.id === selected))
      ? { id: selected, name: label }
      : undefined;

  function show() {
    const rect = trigger.current?.getBoundingClientRect();
    setPlacement(
      rect && window.innerWidth >= ANCHOR_MIN_VIEWPORT
        ? {
            left: Math.round(rect.left),
            top: Math.round(rect.bottom + 4),
            minWidth: Math.round(Math.max(rect.width, 260)),
            maxWidth: `calc(100vw - ${Math.round(rect.left) + 8}px)`,
          }
        : undefined,
    );
    setActive(Math.max(0, selectedIndex));
    typed.current = { text: "", at: 0 };
    setOpen(true);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    close(true);
    if (option.id !== selected) onSelect(option.id);
  }

  useEffect(() => {
    if (!open) return;
    listbox.current?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (listbox.current?.contains(target) || trigger.current?.contains(target)))
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  });

  function onListKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
      return;
    }
    const moved = moveActive(event.key, active, options.length);
    if (moved !== undefined) {
      event.preventDefault();
      setActive(moved);
      return;
    }
    const character = typeAheadCharacter(event);
    if (!character) return;
    const now = Date.now();
    const text = now - typed.current.at < 700 ? typed.current.text + character : character;
    typed.current = { text, at: now };
    const found = typeAhead(options, text, active);
    if (found !== undefined) setActive(found);
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="k-switcher wb-switcher"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`專案：${label}`}
        title={label}
        disabled={!options.length}
        onPointerDown={() => {
          pressIntent.current = open ? "close" : "open";
        }}
        onClick={() => {
          const intent = pressIntent.current ?? (open ? "close" : "open");
          pressIntent.current = undefined;
          if (intent === "close") close(false);
          else show();
        }}
        onKeyDown={(event) => {
          if (open && event.key === "Escape") {
            event.preventDefault();
            close(true);
          } else if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            show();
          }
        }}
      >
        {selectedWorkspace ? (
          <WorkspaceAvatar id={selectedWorkspace.id} name={selectedWorkspace.name} />
        ) : (
          <StackIcon {...iconProps("md")} />
        )}
        <span className="k-switcher__label">{label}</span>
        <CaretUpDownIcon {...iconProps("sm")} />
      </button>
      {open && (
        <div
          ref={listbox}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label="切換專案"
          aria-activedescendant={optionId(active)}
          className="k-popover wb-switcher-list"
          data-width={placement ? "anchor" : undefined}
          style={placement}
          onKeyDown={onListKey}
          onBlur={(event) => {
            const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
            if (!next || !event.currentTarget.contains(next)) setOpen(false);
          }}
        >
          {options.map((option, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox owns keyboard focus and selection (aria-activedescendant).
            <div
              key={option.id ?? "all"}
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === selectedIndex}
              data-active={index === active}
              className="k-option wb-switcher-option"
              onPointerMove={() => setActive(index)}
              onClick={() => choose(index)}
            >
              {option.id ? (
                <WorkspaceAvatar id={option.id} name={option.label} />
              ) : (
                <StackIcon {...iconProps("md")} />
              )}
              <span className="k-option__title k-truncate" title={option.label}>
                {option.label}
              </span>
              {index === selectedIndex ? <CheckIcon {...iconProps("md")} /> : <span />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
