import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import "@holoim/design-tokens/tokens.css";
import "@holoim/design-tokens/fonts.css";

import { router } from "./app/router";
import "./styles/global.css";
import { installTestModules, testHooks } from "./testHooks";

// Debug logging for development
console.log("HoloIM Viewer starting...");
console.log("API Origin:", import.meta.env.VITE_API_ORIGIN);
console.log("WebXR available:", "xr" in navigator);

installTestModules();

// Only show alerts in development and test builds, and only for critical errors
if (testHooks) {
  window.addEventListener("error", (event) => {
    console.error("Global error:", event.error);
  });

  window.addEventListener("unhandledrejection", (event) => {
    console.error("Unhandled rejection:", event.reason);
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
