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

export type ImageEditInput = ImageGenerationInput & {
  referenceImages: {
    filename: string;
    mimeType: 'image/png' | 'image/webp' | 'image/jpeg';
    bytes: Buffer;
  }[];
  inputFidelity?: 'high' | 'low';
};

export interface ImageGenerator {
  generate(input: ImageGenerationInput): Promise<GeneratedImage>;
  edit(input: ImageEditInput): Promise<GeneratedImage>;
}
