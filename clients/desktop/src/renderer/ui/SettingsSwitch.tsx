export function SettingsSwitch({
  accessibleName,
  change,
  checked,
  description,
  disabled,
  title,
}: {
  accessibleName?: string;
  change(checked: boolean): void;
  checked: boolean;
  description: string;
  disabled: boolean;
  title: string;
}) {
  return (
    <div className={disabled ? "settings-row disabled" : "settings-row"}>
      <div><strong>{title}</strong><small>{description}</small></div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={accessibleName ?? title}
        className={checked ? "settings-switch on" : "settings-switch"}
        disabled={disabled}
        onClick={() => change(!checked)}
      >
        <span />
      </button>
    </div>
  );
}
