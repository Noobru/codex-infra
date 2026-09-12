/** Shared output boundary for worker summaries and human observability. */
export class EvidenceSanitizer {
  static text(text:string,maxChars=6000):string {
    return text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email redacted]')
      .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+\b/g,'[credential redacted]')
      .replace(/\bBearer\s+\S+/gi,'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[token redacted]')
      .slice(0,maxChars);
  }
}
