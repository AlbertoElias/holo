interface FrameworkMcpRuntime {
  handles: (method: string) => boolean;
  dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

declare global {
  interface Window {
    FRAMEWORK_MCP_RUNTIME?: FrameworkMcpRuntime;
  }
}

const RUNTIME_READY_EVENT = 'iwsdk:mcp-runtime-ready';

/**
 * Marks the custom HoloIM runtime as ready for IWSDK's plugin-owned browser and
 * IWER tools. HoloIM does not use IWSDK's ECS runtime, so framework methods are
 * deliberately left unclaimed and remain unavailable.
 */
export function announceIwsdkMcpRuntimeReady(): void {
  window.FRAMEWORK_MCP_RUNTIME ??= {
    handles: () => false,
    dispatch: async (method) => {
      throw new Error(`HoloIM does not provide the IWSDK framework method "${method}".`);
    }
  };
  window.dispatchEvent(new Event(RUNTIME_READY_EVENT));
}

