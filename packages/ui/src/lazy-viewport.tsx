import React, { useEffect, useRef, useState } from "react";

interface LazyViewportProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  /** Estimated height for placeholder to prevent layout shift */
  height?: number;
  /** Pre-load margin before element enters viewport */
  rootMargin?: string;
}

/**
 * Renders children only when the element is near the viewport.
 * Uses IntersectionObserver with rootMargin="200px" to pre-load before visible.
 * Once visible, stays rendered (no unmounting on scroll away).
 */
export default function LazyViewport({ children, fallback, height = 100, rootMargin = "200px" }: LazyViewportProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Fall back to immediate render if IntersectionObserver is unavailable
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect(); // once visible, stay rendered
        }
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);

  if (!visible) {
    return (
      <div ref={ref} style={{ minHeight: height }}>
        {fallback ?? <div className="lazy-viewport-placeholder" style={{ height }} />}
      </div>
    );
  }

  return <div ref={ref}>{children}</div>;
}
