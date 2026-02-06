import { base64ToBytes, bytesToBase64 } from "../utils/crypto";

type AesGcmKey = CryptoKey;

const keyCache = new Map<string, Promise<AesGcmKey>>();

const importKey = (keyB64: string) => {
	const cached = keyCache.get(keyB64);
	if (cached) return cached;

	const promise = (async () => {
		const raw = base64ToBytes(keyB64);
		if (raw.byteLength !== 32) {
			throw new Error("PROMPT_ENCRYPTION_KEY must be base64-encoded 32 bytes.");
		}
		return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
			"encrypt",
			"decrypt",
		]);
	})();

	keyCache.set(keyB64, promise);
	return promise;
};

export const encryptPrompt = async (plaintext: string, keyB64: string) => {
	const key = await importKey(keyB64);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = new TextEncoder().encode(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		data,
	);

	return {
		ciphertextB64: bytesToBase64(new Uint8Array(ciphertext)),
		ivB64: bytesToBase64(iv),
	};
};

export const decryptPrompt = async (
	ciphertextB64: string,
	ivB64: string,
	keyB64: string,
) => {
	const key = await importKey(keyB64);
	const iv = base64ToBytes(ivB64);
	const ciphertext = base64ToBytes(ciphertextB64);
	const plaintextBytes = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		ciphertext,
	);
	return new TextDecoder().decode(plaintextBytes);
};
