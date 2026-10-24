import { lazy, Suspense } from "react";
import { createBrowserRouter, useSearchParams } from "react-router-dom";

import { FeedPage } from "../features/feed/FeedPage";
import { ARView } from "../features/ar/ARView";

// The IWSDK World only loads on the immersive routes.
const XrHologramView = lazy(() => import("../features/xr/XrHologramView").then((m) => ({ default: m.XrHologramView })));

function VrRoute() {
  return (
    <Suspense fallback={null}>
      <XrHologramView mode="vr" />
    </Suspense>
  );
}

// The IWSDK AR view runs behind ?shell=iwsdk until it has the R3F view's
// bubble clipping, aura and depth occlusion (viewer-xr-interface brief).
function ArRoute() {
  const [params] = useSearchParams();
  if (params.get("shell") !== "iwsdk") return <ARView />;
  return (
    <Suspense fallback={null}>
      <XrHologramView mode="ar" />
    </Suspense>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <FeedPage />
  },
  {
    path: "/vr/:id",
    element: <VrRoute />
  },
  {
    path: "/ar/:id",
    element: <ArRoute />
  }
]);
