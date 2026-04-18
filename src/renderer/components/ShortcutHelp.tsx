import { useEffect } from "preact/hooks";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  items: { keys: string[]; desc: string }[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    items: [
      { keys: ["Ctrl", "1"], desc: "Overview" },
      { keys: ["Ctrl", "2"], desc: "Largest Files" },
      { keys: ["Ctrl", "3"], desc: "Folders" },
      { keys: ["Ctrl", "4"], desc: "Duplicates" },
      { keys: ["Ctrl", "5"], desc: "Changes" },
      { keys: ["Ctrl", "6"], desc: "Easy Move" },
      { keys: ["Ctrl", "7"], desc: "Memory" },
      { keys: ["Ctrl", "8"], desc: "Settings" },
    ],
  },
  {
    title: "Search & actions",
    items: [
      { keys: ["Ctrl", "F"], desc: "Open search / filter (Largest Files)" },
      { keys: ["?"], desc: "Show this help" },
      { keys: ["Esc"], desc: "Close dialogs / clear search" },
    ],
  },
  {
    title: "File list (Largest Files)",
    items: [
      { keys: ["↑", "↓"], desc: "Move focus" },
      { keys: ["j", "k"], desc: "Move focus (vi-style)" },
      { keys: ["Enter"], desc: "Open focused file" },
      { keys: ["Space"], desc: "Toggle selection on focused file" },
      { keys: ["Delete"], desc: "Move focused file to trash" },
    ],
  },
];

export function ShortcutHelp({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="shortcut-help-backdrop" onClick={onClose}>
      <div className="shortcut-help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shortcut-help-header">
          <div className="shortcut-help-title">Keyboard shortcuts</div>
          <button className="shortcut-help-close" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 3L9 9M9 3L3 9" />
            </svg>
          </button>
        </div>
        <div className="shortcut-help-body">
          {GROUPS.map((group) => (
            <div key={group.title} className="shortcut-help-group">
              <div className="shortcut-help-group-title">{group.title}</div>
              <div className="shortcut-help-items">
                {group.items.map((item, i) => (
                  <div key={i} className="shortcut-help-item">
                    <div className="shortcut-help-keys">
                      {item.keys.map((k, ki) => (
                        <span key={ki}>
                          {ki > 0 && <span className="shortcut-help-sep">+</span>}
                          <kbd className="shortcut-help-key">{k}</kbd>
                        </span>
                      ))}
                    </div>
                    <div className="shortcut-help-desc">{item.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
