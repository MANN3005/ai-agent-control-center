import OpenAI from "openai";
import { requireEnv } from "../config";

let llmClient: OpenAI | null = null;

export function getGroqClient() {
  return getLlmClient();
}

export function getLlmClient() {
  if (llmClient) return llmClient;

  const apiKey = requireEnv("GEMINI_API_KEY");
  const baseURL = "https://generativelanguage.googleapis.com/v1beta/openai";

  llmClient = new OpenAI({
    apiKey,
    baseURL,
  });
  return llmClient;
}

export function getLlmModel(defaultModel = "gemini-3.1-pro-preview") {
  return process.env.GEMINI_MODEL || defaultModel;
}

export async function createJsonObjectCompletion(
  client: OpenAI,
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  temperature = 0.2,
) {
  return client.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
    temperature,
  });
}

export async function createChatCompletionWithFallback(
  client: OpenAI,
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  temperature = 0.2,
) {
  return client.chat.completions.create({
    model,
    messages,
    temperature,
  });
}
