import { useEffect, useState } from "react";

/** Wall clock for relative times: 1 s while a countdown or timer is visible, else 10 s. */
export function useNow(fast: boolean, fixed?: number) {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), fast ? 1000 : 10_000);
    return () => clearInterval(timer);
  }, [fast, fixed]);
  return fixed ?? now;
}
