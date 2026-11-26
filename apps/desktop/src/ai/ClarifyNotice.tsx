/** A question the assistant paused on. Known answers are one click; anything else is typed. */
export function ClarifyNotice({
  question,
  options,
  onPick,
  disabled,
}: {
  question: string;
  options?: string[];
  onPick?: (answer: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ai-notice ai-clarify">
      <span>{question}</span>
      {onPick && options && options.length > 0 && (
        <span className="ai-clarify-options">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="ai-clarify-option"
              disabled={disabled}
              onClick={() => onPick(option)}
            >
              {option}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
