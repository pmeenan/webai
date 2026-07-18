import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

const THEME_STORAGE_KEY = "webai-theme";

type ThemePreference = "dark" | "light" | "system";

function isThemePreference(value: string | undefined): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

function resolveTheme(preference: ThemePreference): "dark" | "light" {
  if (preference !== "system") return preference;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(preference: ThemePreference): void {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
}

const labels: Readonly<Record<ThemePreference, string>> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

export default function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>();

  useEffect(() => {
    const value = document.documentElement.dataset.themePreference;
    if (isThemePreference(value)) setPreference(value);
  }, []);

  useEffect(() => {
    if (preference === undefined) return;
    applyTheme(preference);
    if (preference !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = () => applyTheme("system");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [preference]);

  const chooseTheme = (value: string) => {
    if (!isThemePreference(value)) return;
    setPreference(value);
    applyTheme(value);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
      // Storage can be unavailable in restricted browsing contexts. The in-memory
      // preference remains active for this page without turning that into a failure.
    }
  };

  const triggerIcon =
    preference === undefined || preference === "system" ? (
      <Monitor aria-hidden="true" />
    ) : preference === "dark" ? (
      <Moon aria-hidden="true" />
    ) : (
      <Sun aria-hidden="true" />
    );

  const triggerLabel = preference === undefined ? "Choose theme" : `Theme: ${labels[preference]}`;

  return (
    <div className="theme-control">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="theme-trigger" aria-label={triggerLabel}>
          {triggerIcon}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="theme-menu" align="end">
            <DropdownMenu.Label className="theme-menu-label">Theme</DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={preference ?? ""} onValueChange={chooseTheme}>
              <DropdownMenu.RadioItem className="theme-item" value="dark">
                <Moon aria-hidden="true" />
                <span>Dark</span>
                <DropdownMenu.ItemIndicator className="theme-item-indicator">
                  <Check aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem className="theme-item" value="light">
                <Sun aria-hidden="true" />
                <span>Light</span>
                <DropdownMenu.ItemIndicator className="theme-item-indicator">
                  <Check aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem className="theme-item" value="system">
                <Monitor aria-hidden="true" />
                <span>System</span>
                <DropdownMenu.ItemIndicator className="theme-item-indicator">
                  <Check aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
