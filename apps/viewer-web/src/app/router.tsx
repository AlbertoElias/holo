import { lazy, Suspense } from "react";
import { createBrowserRouter, useParams, useSearchParams } from "react-router-dom";

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

// The feed page keeps one list per source, so each route keys it by what it lists.
function HomeRoute() {
  const [params] = useSearchParams();
  const q = params.get("q")?.trim() ?? "";
  return q ? <FeedPage key={`q:${q}`} source={{ kind: "search", q }} /> : <FeedPage key="all" />;
}

function CreatorRoute() {
  const { userId = "" } = useParams<{ userId: string }>();
  return <FeedPage key={`u:${userId}`} source={{ kind: "creator", ownerId: userId }} />;
}

function HologramRoute() {
  const { id = "" } = useParams<{ id: string }>();
  return <FeedPage key={`h:${id}`} source={{ kind: "one", id }} />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <HomeRoute />
  },
  {
    path: "/u/:userId",
    element: <CreatorRoute />
  },
  {
    path: "/h/:id",
    element: <HologramRoute />
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
