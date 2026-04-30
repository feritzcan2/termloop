import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    RESEND_API_KEY: z.string().min(1),
    TERMLOOP_FEEDBACK_FROM_EMAIL: z.string().email(),
    TERMLOOP_FEEDBACK_RATE_LIMIT_ID: z.string().min(1),
    TERMLOOP_FEEDBACK_RECIPIENT_EMAIL: z.string().email().optional(),
  },
  runtimeEnv: {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    TERMLOOP_FEEDBACK_FROM_EMAIL: process.env.TERMLOOP_FEEDBACK_FROM_EMAIL,
    TERMLOOP_FEEDBACK_RATE_LIMIT_ID: process.env.TERMLOOP_FEEDBACK_RATE_LIMIT_ID,
    TERMLOOP_FEEDBACK_RECIPIENT_EMAIL: process.env.TERMLOOP_FEEDBACK_RECIPIENT_EMAIL,
  },
  skipValidation:
    process.env.SKIP_ENV_VALIDATION === "1" ||
    process.env.VERCEL_ENV === "preview",
});
