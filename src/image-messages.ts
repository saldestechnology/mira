/** User-facing upload messages, kept together for review. */
export const IMAGE_UPLOAD_MESSAGES = {
  actionOverLimit(count: number): string {
    return count === 1
      ? '1 image is over 1 MB and may not upload to this workspace yet. Use a smaller image.'
      : `${count} images are over 1 MB and may not upload to this workspace yet. Use smaller images.`;
  },
  tooBig: 'This image is over 1 MB, which is the upload limit for now. Use a smaller image.',
  tooBigLabel: 'Not uploaded: over 1 MB',
  serverTooBig: 'An image you added is too large for this server.',
  refused: {
    400: 'The server could not read an image you added.',
    402: 'This board has used its image storage. Remove images you no longer need, or ask your administrator.',
    403: "You can't add images to this board.",
    404: 'An image could not be added: the board was not found.',
  } as Record<number, string>,
  refused413(hostedWorkspace: boolean): string {
    return hostedWorkspace ? this.tooBig : this.serverTooBig;
  },
  retryExhausted(status: number): string {
    return `An image could not be uploaded (error ${status}). It will be tried again when you open this board.`;
  },
  lost(count: number): string {
    return count === 1
      ? 'An image could not be uploaded because this browser no longer has it. Add it again.'
      : `${count} images could not be uploaded because this browser no longer has them. Add them again.`;
  },
};
