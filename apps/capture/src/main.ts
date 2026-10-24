import React from 'react';
import { createRoot } from 'react-dom/client';

import '@holoim/design-tokens/fonts.css';
import '@holoim/design-tokens/tokens.css';
import './ui/capture.css';

import { createCaptureRuntime } from './runtime/createCaptureRuntime';
import { CaptureOverlay } from './ui/CaptureOverlay';

async function boot(): Promise<void> {
  const container = document.getElementById('app');
  const uiRootElement = document.getElementById('ui-root');
  if (!container || !uiRootElement) throw new Error('Missing required #app or #ui-root element');

  const runtime = await createCaptureRuntime(container);
  const uiRoot = createRoot(uiRootElement);
  uiRoot.render(React.createElement(CaptureOverlay, { bridge: runtime.uiBridge }));
  await runtime.start();
}

boot().catch((error: unknown) => {
  console.error(error);
});
