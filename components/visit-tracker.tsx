"use client";

import { useEffect } from "react";

export const VISITOR_KEY = "dwtmobile:visitor-id";

export function VisitTracker() {
  useEffect(() => {
    let visitorId = window.localStorage.getItem(VISITOR_KEY);
    if (!visitorId) {
      visitorId = crypto.randomUUID();
      window.localStorage.setItem(VISITOR_KEY, visitorId);
    }

    void fetch("/api/visit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        visitorId,
        path: window.location.pathname
      }),
      keepalive: true
    });
  }, []);

  return null;
}
