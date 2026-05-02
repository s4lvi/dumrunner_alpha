import type { AssetGenConfig } from '../config.js';
import type { GeneratedImage, ImageGenerationInput, ImageGenerator } from './types.js';

type OpenAIImageResponse = {
  data?: { b64_json?: string; revised_prompt?: string }[];
  error?: { message?: string };
};

export class OpenAIImageGenerator implements ImageGenerator {
  constructor(private readonly config: AssetGenConfig) {}

  async generate(input: ImageGenerationInput): Promise<GeneratedImage> {
    if (!this.config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required for OpenAI image generation');
    }

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.openaiApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.imageModel,
        prompt: input.prompt,
        size: input.size,
        quality: input.quality,
        output_format: 'png',
        background: input.background,
        moderation: 'auto',
      }),
    });

    const providerRequestId = response.headers.get('x-request-id');
    const body = (await response.json().catch(() => ({}))) as OpenAIImageResponse;

    if (!response.ok) {
      throw new Error(body.error?.message ?? `OpenAI image generation failed: ${response.status}`);
    }

    const first = body.data?.[0];
    if (!first?.b64_json) {
      throw new Error('OpenAI image generation returned no image data');
    }

    return {
      mimeType: 'image/png',
      bytes: Buffer.from(first.b64_json, 'base64'),
      revisedPrompt: first.revised_prompt ?? null,
      providerRequestId,
    };
  }
}

export class PlaceholderImageGenerator implements ImageGenerator {
  async generate(): Promise<GeneratedImage> {
    return {
      mimeType: 'image/png',
      bytes: Buffer.from(MINIMAL_PNG_BASE64, 'base64'),
      revisedPrompt: null,
      providerRequestId: 'placeholder',
    };
  }
}

const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAFgwJ/lJ8QpAAAAABJRU5ErkJggg==';
