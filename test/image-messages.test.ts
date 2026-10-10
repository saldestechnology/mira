import { describe, expect, it } from 'vitest';
import { IMAGE_UPLOAD_MESSAGES } from '../src/image-messages';

describe('image upload messages', () => {
  it('varies the whole over-the-limit sentence with the count', () => {
    expect(IMAGE_UPLOAD_MESSAGES.actionOverLimit(1)).toBe('1 image is over 1 MB and may not upload to this workspace yet. Use a smaller image.');
    expect(IMAGE_UPLOAD_MESSAGES.actionOverLimit(2)).toBe('2 images are over 1 MB and may not upload to this workspace yet. Use smaller images.');
    expect(IMAGE_UPLOAD_MESSAGES.actionOverLimit(5)).toBe('5 images are over 1 MB and may not upload to this workspace yet. Use smaller images.');
  });

  it('says error and the status in the five-failures notice, and ends every toast with a full stop', () => {
    expect(IMAGE_UPLOAD_MESSAGES.retryExhausted(502)).toBe('An image could not be uploaded (error 502). It will be tried again when you open this board.');
    const toasts = [
      IMAGE_UPLOAD_MESSAGES.actionOverLimit(1), IMAGE_UPLOAD_MESSAGES.actionOverLimit(3), IMAGE_UPLOAD_MESSAGES.tooBig,
      IMAGE_UPLOAD_MESSAGES.serverTooBig, IMAGE_UPLOAD_MESSAGES.retryExhausted(307), IMAGE_UPLOAD_MESSAGES.lost(1), IMAGE_UPLOAD_MESSAGES.lost(2),
      ...Object.values(IMAGE_UPLOAD_MESSAGES.refused),
    ];
    for (const t of toasts) expect(t.endsWith('.')).toBe(true);
    expect(IMAGE_UPLOAD_MESSAGES.tooBig).toBe('This image is over 1 MB, which is the upload limit for now. Use a smaller image.');
  });

  it('keeps the two placeholder labels in the same form, with a colon', () => {
    expect(IMAGE_UPLOAD_MESSAGES.tooBigLabel).toBe('Not uploaded: over 1 MB');
  });
});
