import { useCallback, useEffect, useState } from "react";
import type { UserDTO } from "@holoim/contracts";

import { fetchCurrentUser, signOut } from "./auth";

export function useCurrentUser() {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      setUser(await fetchCurrentUser());
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await signOut();
    setUser(null);
  }, []);

  return { user, isLoading, refresh, logout };
}
