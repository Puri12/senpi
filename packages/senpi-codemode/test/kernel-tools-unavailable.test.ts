import { describe, expect, it } from "vitest";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { SubprocessKernel } from "../src/kernels/shared/subprocess-kernel.ts";

describe("py/rb/jl kernel tools", () => {
	it("returns tools_unavailable from real non-JS kernel classes", async () => {
		await expect(PythonKernel.prototype.describeKernelTools(["lookup"])).rejects.toMatchObject({
			code: "tools_unavailable",
		});
		await expect(PythonKernel.prototype.invokeKernelTool({})).rejects.toMatchObject({ code: "tools_unavailable" });
		await expect(SubprocessKernel.prototype.describeKernelTools(["lookup"])).rejects.toMatchObject({
			code: "tools_unavailable",
		});
		await expect(SubprocessKernel.prototype.invokeKernelTool({})).rejects.toMatchObject({
			code: "tools_unavailable",
		});
	});
});
