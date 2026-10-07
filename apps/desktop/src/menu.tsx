import { DotsThree, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  type FocusEvent,
  Fragment,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "./components.tsx";

export type MenuItem = {
  id: string;
  label: string;
  icon: PhosphorIcon;
  /** Destructive items read in the danger colour and sit in their own group. */
  danger?: boolean;
  /** Unavailable items stay in the list (so the menu keeps its shape) with the reason shown. */
  disabledReason?: string;
  onSelect: (trigger: HTMLButtonElement) => void;
};

/** Arrow keys, Home and End move through the items and wrap; null for any other key. */
export function menuIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * A `DotsThree` menu button (WAI-ARIA menu pattern): Enter, Space or ↓ opens on the first
 * item, ↑ on the last; arrows move, Esc closes and returns focus to the button, Tab or a
 * press outside closes. Choosing an item hands focus back to the button first, so a dialog
 * opened from the menu returns focus there when it closes.
 */
export function OverflowMenu({
  id,
  label,
  items,
  disabled = false,
}: {
  id: string;
  label: string;
  items: MenuItem[];
  disabled?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<"first" | "last" | null>(null);
  const [above, setAbove] = useState(false);
  const menuId = useId();

  useLayoutEffect(() => {
    const element = menu.current;
    const button = trigger.current;
    if (!open || !element || !button) return;
    // Open upward when the scrolling page has no room below the button.
    const bounds = (
      button.closest(".desk-main") ?? document.documentElement
    ).getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const height = element.offsetHeight;
    setAbove(rect.bottom + height + 12 > bounds.bottom && rect.top - height - 12 > bounds.top);
    const entries = element.querySelectorAll<HTMLElement>('[role="menuitem"]');
    entries[open === "last" ? entries.length - 1 : 0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (menu.current?.contains(target) || trigger.current?.contains(target))
      )
        return;
      setOpen(null);
    };
    document.addEventListener("pointerdown", press);
    return () => document.removeEventListener("pointerdown", press);
  }, [open]);

  const closeToTrigger = () => {
    setOpen(null);
    trigger.current?.focus();
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(event.key === "ArrowUp" ? "last" : "first");
    }
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeToTrigger();
      return;
    }
    if (event.key === "Tab") {
      setOpen(null);
      return;
    }
    const entries = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const next = menuIndex(
      event.key,
      entries.indexOf(document.activeElement as HTMLElement),
      entries.length,
    );
    if (next === null) return;
    event.preventDefault();
    entries[next]?.focus();
  };

  // Focus that leaves both the menu and its button (a click elsewhere, a dialog) closes it.
  const onMenuBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (menu.current?.contains(next) || trigger.current === next)) return;
    setOpen(null);
  };

  const choose = (item: MenuItem) => {
    const button = trigger.current;
    if (item.disabledReason || !button) return;
    setOpen(null);
    button.focus();
    item.onSelect(button);
  };

  return (
    <div className="desk-menu-wrap">
      <button
        ref={trigger}
        id={id}
        className="k-btn k-btn--quiet k-btn--icon k-btn--sm"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => (current ? null : "first"))}
        onKeyDown={onTriggerKey}
      >
        <Icon icon={DotsThree} size="lg" />
      </button>
      {open ? (
        <div
          ref={menu}
          id={menuId}
          className="desk-menu"
          role="menu"
          aria-label={label}
          data-placement={above ? "above" : undefined}
          onKeyDown={onMenuKey}
          onBlur={onMenuBlur}
        >
          {items.map((item, index) => (
            <Fragment key={item.id}>
              {item.danger && index > 0 ? <hr className="desk-menu__sep" /> : null}
              <button
                className="desk-menu__item"
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-tone={item.danger ? "danger" : undefined}
                aria-disabled={item.disabledReason ? true : undefined}
                onClick={() => choose(item)}
              >
                <Icon icon={item.icon} />
                <span className="desk-menu__text">
                  {item.label}
                  {item.disabledReason ? (
                    <span className="desk-menu__note">{item.disabledReason}</span>
                  ) : null}
                </span>
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
