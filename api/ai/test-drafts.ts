import { createTestDraftHandler } from '../_lib/testDraftHandler.js';

// 환경변수(GROQ_API_KEY · LOOMA_AI_ACCESS_CODE)는 서버에서만 읽는다. 브라우저 번들에는 들어가지 않는다.
export const POST = createTestDraftHandler({ env: process.env, fetch: (...args) => fetch(...args), now: () => Date.now() });
