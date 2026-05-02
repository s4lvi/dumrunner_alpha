import type { AssetGenConfig } from '../config.js';
import type {
  GeneratedImage,
  ImageEditInput,
  ImageGenerationInput,
  ImageGenerator,
} from './types.js';

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

  async edit(input: ImageEditInput): Promise<GeneratedImage> {
    if (!this.config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required for OpenAI image editing');
    }

    const form = new FormData();
    form.set('model', this.config.imageModel);
    form.set('prompt', input.prompt);
    form.set('size', input.size);
    form.set('quality', input.quality);
    form.set('output_format', 'png');
    form.set('background', input.background);
    if (input.inputFidelity && !this.config.imageModel.startsWith('gpt-image-2')) {
      form.set('input_fidelity', input.inputFidelity);
    }
    for (const reference of input.referenceImages) {
      form.append(
        'image[]',
        new Blob([reference.bytes], { type: reference.mimeType }),
        reference.filename
      );
    }

    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.openaiApiKey}`,
      },
      body: form,
    });

    const providerRequestId = response.headers.get('x-request-id');
    const body = (await response.json().catch(() => ({}))) as OpenAIImageResponse;

    if (!response.ok) {
      throw new Error(body.error?.message ?? `OpenAI image edit failed: ${response.status}`);
    }

    const first = body.data?.[0];
    if (!first?.b64_json) {
      throw new Error('OpenAI image edit returned no image data');
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

  async edit(): Promise<GeneratedImage> {
    return this.generate();
  }
}

const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAFgwJ/lJ8QpAAAAABJRU5ErkJggg==';
