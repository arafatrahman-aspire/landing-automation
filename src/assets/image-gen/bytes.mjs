export function extFromMime(mime) {
  const type = String(mime ?? "").split(";")[0].trim().toLowerCase();
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  return "jpg";
}

export function sniffMime(bytes) {
  if (!bytes || bytes.length < 12) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return "image/jpeg";
}

export function decodeBase64Image(data, mimeHint) {
  const cleaned = String(data ?? "").replace(/^data:[^;]+;base64,/, "").trim();
  if (!cleaned) throw new Error("empty base64 image payload");
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length < 50) throw new Error("decoded image too small");
  const mime = mimeHint && String(mimeHint).startsWith("image/") ? String(mimeHint).split(";")[0] : sniffMime(bytes);
  return { bytes, mime, ext: extFromMime(mime) };
}

export async function responseToImage(res) {
  if (!res?.ok) throw new Error(`image download HTTP ${res?.status ?? 0}`);
  const headerMime = res.headers?.get?.("content-type");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 50) throw new Error("image download too small");
  const mime = headerMime && String(headerMime).startsWith("image/") ? String(headerMime).split(";")[0] : sniffMime(buf);
  return { bytes: buf, mime, ext: extFromMime(mime) };
}

export function jsonField(obj, ...keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value != null && value !== "") return value;
  }
  return undefined;
}
