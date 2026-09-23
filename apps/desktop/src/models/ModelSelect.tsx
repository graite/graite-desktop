import { Children, isValidElement, type ReactNode } from "react";
import { Select } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

/** Shared model picker: keyboard navigation, type-ahead and a styled, scrollable menu. */
export function ModelSelect({
  value,
  onValueChange,
  disabled,
  label,
  children,
}: {
  value: string | number;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  children: ReactNode;
}) {
  const options = Children.toArray(children).filter(
    isValidElement<{ value: string | number; children: ReactNode; disabled?: boolean }>,
  );
  return (
    <Select.Root
      value={`value:${value}`}
      onValueChange={(next) => onValueChange(next.slice(6))}
      disabled={disabled}
    >
      <Select.Trigger className="ai-select-trigger" aria-label={label}>
        <Select.Value />
        <Select.Icon className="ai-select-chevron">
          <ChevronDown size={15} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="ai-select-menu"
          position="popper"
          sideOffset={7}
          collisionPadding={12}
        >
          <Select.ScrollUpButton className="ai-select-scroll">
            <ChevronUp size={14} />
          </Select.ScrollUpButton>
          <Select.Viewport className="ai-select-viewport">
            {options.map((option) => (
              <Select.Item
                key={String(option.props.value)}
                value={`value:${option.props.value}`}
                disabled={option.props.disabled}
                className="ai-select-option"
              >
                <Select.ItemText>{option.props.children}</Select.ItemText>
                <Select.ItemIndicator className="ai-select-check">
                  <Check size={14} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="ai-select-scroll">
            <ChevronDown size={14} />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
