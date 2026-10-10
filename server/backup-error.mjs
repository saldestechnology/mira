/** A stable error shape shared by the S3 and directory backup clients. */
export class BackupError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.s3Code) this.s3Code = extra.s3Code;
    if (extra.retryable) Object.defineProperty(this, 'retryable', { value: true });
  }
}
