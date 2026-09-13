import { AppError } from '@pavisie/core';

/** 503, `expose: true` — the plugin/provider isn't usable right now, and the reason is meant to reach the user (SPEC.md §I: "explain why in /plugin status", and every command should say the same thing). */
export class MediaUnavailableError extends AppError {
  constructor(message: string) {
    super('media_unavailable', message, { status: 503, expose: true });
    this.name = 'MediaUnavailableError';
  }
}
