export const COPILOT_API_URL = "https://api.githubcopilot.com";

export const API_URL = process.env.COPILOT_API_URL || COPILOT_API_URL;

export const API_PATH = API_URL === COPILOT_API_URL ? "/chat/completions" : "/v1/chat/completions";

console.log(`[API Server] ${API_URL}`);
