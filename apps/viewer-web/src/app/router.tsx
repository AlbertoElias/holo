import { lazy, Suspense } from "react";
import { createBrowserRouter, useSearchParams } from "react-router-dom";

import { FeedPage } from "../features/feed/FeedPage";
import { AuthVerifyPage } from "../features/auth/AuthVerifyPage";

// The IWSDK World only loads on the immersive routes.
const XrHologramView = lazy(() => import("../features/xr/XrHologramView").then((m) => ({ default: m.XrHologramView })));
// The R3F AR view pulls in @react-three/xr, which the feed never needs.
const ARView = lazy(() => import("../features/ar/ARView").then((m) => ({ default: m.ARView })));

function VrRoute() {
  return (
    <Suspense fallback={null}>
      <XrHologramView mode="vr" />
    </Suspense>
  );
}

// The IWSDK AR view is the default (viewer-xr-interface step 6); the R3F
// view stays behind ?shell=r3f as a temporary fallback.
function ArRoute() {
  const [params] = useSearchParams();
  return (
    <Suspense fallback={null}>
      {params.get("shell") === "r3f" ? <ARView /> : <XrHologramView mode="ar" />}
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
    path: "/auth/verify",
    element: <AuthVerifyPage />
  },
  {
    path: "/ar/:id",
    element: <ArRoute />
  }
]);
