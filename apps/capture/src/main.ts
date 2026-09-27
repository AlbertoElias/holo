import { createRoot } from "react-dom/client";
import React from "react";

import { createApp } from './app/createApp';
import { announceIwsdkMcpRuntimeReady } from './debug/iwsdkMcpRuntime';
import { CaptureOverlay } from './ui/CaptureOverlay';

const app = createApp();
const uiRootElement = document.getElementById("ui-root");

if (!uiRootElement) {
  throw new Error("Missing required #ui-root element");
}

createRoot(uiRootElement).render(React.createElement(CaptureOverlay, { bridge: app.uiBridge }));

app
  .start()
  .then(() => announceIwsdkMcpRuntimeReady())
  .catch((error) => {
    console.error(error);
  });
