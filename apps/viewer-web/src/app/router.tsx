import { createBrowserRouter } from "react-router-dom";

import { FeedPage } from "../features/feed/FeedPage";
import { ARView } from "../features/ar/ARView";
import { AuthVerifyPage } from "../features/auth/AuthVerifyPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <FeedPage />
  },
  {
    path: "/auth/verify",
    element: <AuthVerifyPage />
  },
  {
    path: "/ar/:id",
    element: <ARView />
  }
]);
