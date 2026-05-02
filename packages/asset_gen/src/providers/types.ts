export type GeneratedImage = {
  mimeType: 'image/png' | 'image/webp' | 'image/jpeg';
  bytes: Buffer;
  revisedPrompt: string | null;
  providerRequestId: string | null;
};

export type ImageGenerationInput = {
  prompt: string;
  size: string;
  quality: 'low' | 'medium' | 'high' | 'auto';
  background: 'transparent' | 'opaque' | 'auto';
};

export interface ImageGenerator {
  generate(input: ImageGenerationInput): Promise<GeneratedImage>;
}
