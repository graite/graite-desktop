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
        <span className="startup-caption">A little space for your ideas</span>
      )}
    </div>
  );
}
