import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

/**
 * GET `url` every `intervalMs` until `isDone(data)`. A failed request stops polling and sets
 * `error`; `restart()` resumes (also used after cancel/continue to pick up new states).
 * Data is keyed by URL so a new job never shows the previous job's data.
 */
export function usePoll<T>(url: string | null, isDone: (data: T) => boolean, intervalMs = 1000) {
  const [result, setResult] = useState<{ url: string; data: T } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [generation, setGeneration] = useState(0);
  const isDoneRef = useRef(isDone);
  useEffect(() => {
    isDoneRef.current = isDone;
  });

  useEffect(() => {
    if (!url) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const data = await api<T>(url);
        if (stopped) return;
        setResult({ url, data });
        setError(null);
        if (!isDoneRef.current(data)) timer = setTimeout(tick, intervalMs);
      } catch (err) {
        if (!stopped) setError(err instanceof ApiError ? err : new ApiError(0, String(err)));
      }
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [url, intervalMs, generation]);

  const restart = useCallback(() => {
    setError(null);
    setGeneration((g) => g + 1);
  }, []);

  return { data: result && result.url === url ? result.data : null, error, restart };
}
