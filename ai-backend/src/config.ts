/** Central configuration constants for the BOTD AI backend. */
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Outbound Gemini deadline. 60s covers Render/Railway cold starts, queued
 * generations and long JSON outputs — flash models usually answer in <10s.
 * The free Gemini REST API itself may cut slower responses earlier, in which
 * case the caller still surfaces the upstream message (never a raw dump).
 */
export const GEMINI_TIMEOUT_MS = 60_000;
