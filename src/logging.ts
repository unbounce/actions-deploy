// GitHub Actions Annotations

export const warning = (message: string) => console.log(`::warning ${message}`);
export const error = (message: string) => console.log(`::error ${message}`);
export const debug = (message: string) => console.log(`::debug ${message}`);
