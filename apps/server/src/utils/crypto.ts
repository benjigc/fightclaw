export const sha256Hex = async (input: string) => {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

export const bytesToBase64 = (bytes: Uint8Array) => {
	return Buffer.from(bytes).toString("base64");
};

export const base64ToBytes = (b64: string) => {
	return new Uint8Array(Buffer.from(b64, "base64"));
};

export const base64UrlEncode = (bytes: Uint8Array) => {
	// Buffer is available under nodejs_compat; avoids btoa unicode pitfalls.
	return Buffer.from(bytes)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
};

export const base64UrlDecode = (value: string): Uint8Array => {
	let b64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const pad = b64.length % 4;
	if (pad === 2) b64 += "==";
	else if (pad === 3) b64 += "=";
	else if (pad !== 0) throw new Error("Invalid base64url string.");
	return new Uint8Array(Buffer.from(b64, "base64"));
};

export const randomBase64Url = (bytes: number) => {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return base64UrlEncode(arr);
};
