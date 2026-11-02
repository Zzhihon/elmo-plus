export const GEO_KNOWLEDGE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface GeoKnowledgeFileType {
	mime: string;
	ext: string;
	label: string;
}

const PDF: GeoKnowledgeFileType = { mime: "application/pdf", ext: "pdf", label: "PDF" };
const DOCX: GeoKnowledgeFileType = {
	mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	ext: "docx",
	label: "Word",
};
const DOC: GeoKnowledgeFileType = { mime: "application/msword", ext: "doc", label: "Word 97-2003" };
const PNG: GeoKnowledgeFileType = { mime: "image/png", ext: "png", label: "PNG" };
const JPEG: GeoKnowledgeFileType = { mime: "image/jpeg", ext: "jpg", label: "JPEG" };
const WEBP: GeoKnowledgeFileType = { mime: "image/webp", ext: "webp", label: "WebP" };

export const GEO_KNOWLEDGE_FILE_TYPES: readonly GeoKnowledgeFileType[] = [PDF, DOCX, DOC, PNG, JPEG, WEBP];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
	return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.subarray(start, end));
}

function containsAscii(bytes: Uint8Array, needle: string): boolean {
	const target = Array.from(needle, (char) => char.charCodeAt(0));
	outer: for (let index = 0; index <= bytes.length - target.length; index++) {
		for (let offset = 0; offset < target.length; offset++) {
			if (bytes[index + offset] !== target[offset]) continue outer;
		}
		return true;
	}
	return false;
}

function extensionOf(fileName: string): string {
	const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
	return match ? match[1].toLowerCase() : "";
}

/**
 * What the bytes are, not what the browser claims. Word files need both the
 * container signature and the matching extension, because a zip or an OLE
 * compound file on its own could be many other things.
 */
export function sniffKnowledgeFile(bytes: Uint8Array, fileName: string): GeoKnowledgeFileType | null {
	if (ascii(bytes, 0, 5) === "%PDF-") return PDF;
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return WEBP;
	const extension = extensionOf(fileName);
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && extension === "docx" && containsAscii(bytes, "word/document.xml")) {
		return DOCX;
	}
	if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && extension === "doc") return DOC;
	return null;
}

/** A name to show people, never a storage key or a path. */
export function displayFileName(fileName: string): string {
	const base = fileName.split(/[\\/]/).pop() ?? "";
	const cleaned = Array.from(base)
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code >= 0x20 && code !== 0x7f;
		})
		.join("")
		.trim();
	return (cleaned || "未命名文件").slice(0, 200);
}
