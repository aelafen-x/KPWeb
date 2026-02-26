import { useEffect } from "react";

type StatusBannerProps = {
  status?: string;
  error?: string;
  kind?: "info" | "success";
  onClearStatus?: () => void;
};

export function StatusBanner({
  status,
  error,
  kind = "success",
  onClearStatus
}: StatusBannerProps): JSX.Element | null {
  useEffect(() => {
    if (!status || kind !== "success") {
      return;
    }
    const timer = window.setTimeout(() => {
      onClearStatus?.();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [status, kind, onClearStatus]);

  if (error) {
    return <div className="status-banner error">{error}</div>;
  }
  if (status) {
    return <div className={`status-banner ${kind}`}>{status}</div>;
  }
  return null;
}
