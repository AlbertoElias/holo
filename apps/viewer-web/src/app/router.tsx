import { createBrowserRouter } from "react-router-dom";

import { FeedPage } from "../features/feed/FeedPage";
import { ARView } from "../features/ar/ARView";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <FeedPage />
  },
  {
    path: "/ar/:id",
    element: <ARView />
  }
]);
