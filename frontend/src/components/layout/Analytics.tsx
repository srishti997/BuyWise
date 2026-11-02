"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { GA_ID, pageview, flushAnalytics, initializeAnalytics, track } from "@/lib/analytics";

/** Sends a page_view on every client-side route change. */
function RouteTracker() {
  const pathname = usePathname();
  const search = useSearchParams();
  const lastLocation = useRef<string | null>(null);
  const location = `${pathname}?${search.toString()}`;
  useEffect(() => {
    if (!pathname || lastLocation.current === location) return;
    lastLocation.current = location;
    pageview(pathname);
    if (!pathname.startsWith("/auth/")) {
      try {
        const method = sessionStorage.getItem("buywise:login-completed");
        if (method) { sessionStorage.removeItem("buywise:login-completed"); track("login", { method }); }
      } catch { /* storage may be unavailable */ }
    }
  }, [pathname, location]);
  return null;
}

/**
 * Google Analytics 4. Renders nothing unless a measurement id is configured, so
 * unconfigured builds and variant previews send no traffic. Page views are sent manually on
 * route changes because the app navigates client-side.
 */
export default function Analytics() {
  const pathname = usePathname();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => { if (active) setEnabled(initializeAnalytics()); });
    return () => { active = false; };
  }, [pathname]);
  if (!GA_ID || !enabled || pathname.startsWith("/auth/callback")) return null;
  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`} strategy="afterInteractive" onReady={flushAnalytics} />
      <Suspense fallback={null}>
        <RouteTracker />
      </Suspense>
    </>
  );
}
