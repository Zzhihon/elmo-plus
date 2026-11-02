import { describe, expect, it } from "vitest";
import { renderDraftMarkdown } from "../drafts-render";

function exported(body: string, title = "选型问答") {
	return renderDraftMarkdown({ title, body, claims: [] });
}

describe("the Markdown release file", () => {
	it("keeps HTML from rendering when pasted into a CMS", () => {
		const document = exported('正文<script>alert(1)</script><img src=x onerror="alert(1)">', "<b>标题</b>");
		expect(document).not.toContain("<script");
		expect(document).not.toContain("<img");
		expect(document).not.toContain("<b>");
	});

	it("drops a link that leads anywhere but the web or a mailbox", () => {
		expect(exported("[点我](javascript:alert(1))")).not.toContain("javascript:");
		expect(exported("[点我](data:text/html;base64,AAAA)")).not.toContain("data:");
		expect(exported("[点我]: javascript:alert(1)")).not.toContain("javascript:");
	});

	it("leaves ordinary links as they are", () => {
		expect(exported("[官网](https://www.example-electric.test/a)")).toContain(
			"[官网](https://www.example-electric.test/a)",
		);
		expect(exported("[联系](mailto:info@example-electric.test)")).toContain("mailto:info@example-electric.test");
	});
});
