import { useEffect, useState } from "preact/hooks";

/** True when viewport width is ≤ `breakpoint` px (default matches bottom-nav: 767). */
export function useIsMobile(breakpoint = 767): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia(`(max-width: ${breakpoint}px)`).matches
      : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpoint]);

  return mobile;
}
