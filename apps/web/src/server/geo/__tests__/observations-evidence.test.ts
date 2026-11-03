import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/lib/db/db", () => ({ db: {} }));
vi.mock("@/lib/geo/enqueue", () => ({ enqueueGeoJob: vi.fn() }));
vi.mock("@/server/geo/context", () => ({ geoRequestId: () => "req-1" }));
vi.mock("@workspace/lib/geo/audit", () => ({ writeGeoAudit: vi.fn() }));

const put = vi.fn();
const scanUpload = vi.fn();
vi.mock("@workspace/geo-evidence", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/geo-evidence")>()),
	getObjectStore: () => ({ put }),
	scanUpload,
}));

const { sniffEvidenceType, uploadEvidenceFile } = await import("../observations-import-core");
const { assertSameOrigin, evidenceHeaders } = await import("../observations-routes");

const bytes = (...values: number[]) => new Uint8Array([...values, ...new Array(16).fill(0)]);
const ascii = (text: string) => new Uint8Array([...new TextEncoder().encode(text), ...new Array(16).fill(0)]);

describe("evidence uploads", () => {
	it("recognises screenshots and PDFs by their bytes", () => {
		expect(sniffEvidenceType(bytes(0x89, 0x50, 0x4e, 0x47))?.mime).toBe("image/png");
		expect(sniffEvidenceType(bytes(0xff, 0xd8, 0xff))?.mime).toBe("image/jpeg");
		expect(sniffEvidenceType(ascii("%PDF-1.7"))?.mime).toBe("application/pdf");
	});

	it("refuses HTML or SVG whatever the upload claims to be", () => {
		expect(sniffEvidenceType(ascii("<html><script>alert(1)</script>"))).toBeNull();
		expect(sniffEvidenceType(ascii("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
	});

	it("refuses a file the malware scan flags and never stores it", async () => {
		scanUpload.mockResolvedValueOnce({ status: "INFECTED", engine: "clamd", signature: "Eicar-Test-Signature" });
		const principal = { organizationId: "org", actorId: "u1", actorKind: "user", roles: ["geo_operator"], requestId: "r" } as const;
		const file = new File([ascii("%PDF-1.7")], "evidence.pdf");
		await expect(uploadEvidenceFile(principal, file)).rejects.toThrow("恶意文件扫描");
		expect(put).not.toHaveBeenCalled();
	});

	it("serves non-images as downloads that cannot run scripts", () => {
		const headers = new Headers(evidenceHeaders("application/pdf", "a.pdf"));
		expect(headers.get("Content-Disposition")).toMatch(/^attachment/);
		expect(headers.get("Content-Security-Policy")).toContain("sandbox");
		expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
	});
});

describe("session upload route", () => {
	const url = "https://app.example.test/api/geo/acme/evidence";

	it("accepts a same-origin request", () => {
		expect(() => assertSameOrigin(new Request(url, { headers: { Origin: "https://app.example.test" } }))).not.toThrow();
	});

	it("refuses a cross-site request", () => {
		expect(() => assertSameOrigin(new Request(url, { headers: { Origin: "https://evil.example.test" } }))).toThrow();
		expect(() => assertSameOrigin(new Request(url, { headers: { "Sec-Fetch-Site": "cross-site" } }))).toThrow();
		expect(() => assertSameOrigin(new Request(url))).toThrow();
	});
});
