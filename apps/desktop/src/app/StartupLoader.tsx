/** How the caption "A place where …" ends, one after another. The same list is written out in
 * index.html (the pre-JavaScript shell) and timed in public/startup.css: change all three. */
export const STARTUP_WORDS = [
  "ideas grow",
  "notes connect",
  "mail gets answered",
  "clients stay close",
  "projects move",
  "your AI stays yours",
];

/** Matches the pre-JavaScript shell in index.html so startup has no blank flash. */
export function StartupLoader({
  error,
  onRetry,
  onChooseVault,
}: {
  error?: string;
  onRetry?: () => void;
  onChooseVault?: () => void;
}) {
  return (
    <div className="startup-loader" role="status" aria-label="Opening Graite">
      <div className="startup-mark" aria-hidden="true">
        <div className="startup-sweep" />
      </div>
      <span className="startup-name">Graite</span>
      {error ? (
        <div className="startup-error" role="alert">
          <p>Could not open your workspace.</p>
          <small>{error}</small>
          <button onClick={onRetry}>Try again</button>
          {onChooseVault && <button onClick={onChooseVault}>Choose another vault</button>}
        </div>
      ) : (
        <span className="startup-caption">
          <span>A place where</span>
          <span className="startup-words" aria-hidden="true">
            <span className="startup-roll">
              {[...STARTUP_WORDS, STARTUP_WORDS[0]].map((words, index) => (
                <span key={index}>{words}</span>
              ))}
            </span>
          </span>
        </span>
      )}
    </div>
  );
}
