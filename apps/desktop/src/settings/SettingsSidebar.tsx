import { ArrowLeft } from "lucide-react";
import { DaemonStatus } from "@/app/DaemonStatus";
import { ThemeToggle, VaultMenu } from "@/app/Sidebar";
import { useTechMode } from "@/lib/techMode";
import { visibleNav, type SettingsSection } from "./sections";

/** The sidebar while Settings is open: the same frame as the app's sidebar, with the settings
 * sections where the pages and Studio would be. */
export function SettingsSidebar({
  section,
  inUse,
  onSection,
  onBack,
}: {
  section: SettingsSection;
  /** The section whose model chat uses now. */
  inUse: SettingsSection | null;
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  const [techMode] = useTechMode();
  return (
    <div className="flex h-full flex-col border-r bg-sidebar">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <img src="/logo-graite.svg" alt="Graite" className="size-5 shrink-0 dark:invert" />
        <VaultMenu />
        <ThemeToggle />
      </div>
      <div className="px-3 pb-1 pt-3">
        <button
          type="button"
          onClick={onBack}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent"
        >
          <ArrowLeft size={15} /> Back to pages
        </button>
      </div>
      <nav className="settings-nav" aria-label="Settings sections">
        {visibleNav(techMode, [inUse, section]).map((group, i) => (
          <div key={group.title ?? i} className="settings-nav-group">
            {group.title && <div className="settings-nav-title">{group.title}</div>}
            {group.items.map(({ id, label, icon: Icon, sub }) => (
              <button
                key={id}
                type="button"
                aria-current={section === id ? "page" : undefined}
                data-sub={sub || undefined}
                onClick={() => onSection(id)}
              >
                <Icon size={15} />
                <span>{label}</span>
                {inUse === id && (
                  <small title="Chat uses the model set up here" aria-label="used for chat">
                    In use
                  </small>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="border-t px-2 py-1.5">
        <DaemonStatus compact />
      </div>
    </div>
  );
}
