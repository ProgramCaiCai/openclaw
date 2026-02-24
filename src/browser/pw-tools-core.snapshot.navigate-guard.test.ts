import { describe, expect, it, vi } from "vitest";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.snapshot.js");

describe("pw-tools-core.snapshot navigate guard", () => {
  it("blocks unsupported non-network URLs before page lookup", async () => {
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "about:blank"),
    });

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(getPwToolsCoreSessionMocks().getPageForTargetId).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it("navigates valid network URLs with clamped timeout", async () => {
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://93.184.216.34"),
    });

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://93.184.216.34",
      timeoutMs: 10,
    });

    expect(goto).toHaveBeenCalledWith("https://93.184.216.34", { timeout: 1000 });
    expect(result.url).toBe("https://93.184.216.34");
  });
});
