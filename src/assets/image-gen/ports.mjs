/* Image-generation ports. JSDoc contracts only — adapters implement these
 * shapes. Upload stays in campaign-images.mjs (existing Supabase path). */

/**
 * @typedef {object} GeneratedImage
 * @property {Buffer} bytes
 * @property {string} mime
 * @property {string} ext
 * @property {string} [provider]
 */

/**
 * @typedef {object} IImageGenerator
 * @property {(prompt: string) => Promise<GeneratedImage>} generate
 *   Generates an image from the prompt and returns in-memory bytes.
 *   Throws on failure so FallbackImageGenerator can try the next provider.
 */

export const GENERATED_IMAGE_WIDTH = 1280;
export const GENERATED_IMAGE_HEIGHT = 768;

export const DEFAULT_GENERATOR_ORDER = [
  "cloudflare",
  "nanobanana",
  "leonardo",
  "promptgone",
  "journey",
];
